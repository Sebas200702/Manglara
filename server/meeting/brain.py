"""Cerebro de Manglara en la reunión: una sesión Gemini Live encendible/apagable.

Reusa `GeminiLiveClient` tal cual (mismo pipeline que la llamada 1:1). El
bridge le pasa el PCM remoto de la reunión y recibe de vuelta el audio de
Manglara, las transcripciones y los eventos de turno por callbacks.

Half-duplex anti-eco (mismo patrón que la llamada 1:1): mientras el audio de
Manglara se está reproduciendo en la reunión, y `MIC_REOPEN_GUARD_S` después,
el audio remoto NO se envía a Gemini. Así su propia voz, si algún participante
la devuelve por altavoces, no se convierte en un turno nuevo.

Las sesiones de Gemini Live tienen duración limitada; si la sesión cae con el
cerebro encendido se reconecta sola (sin volver a presentarse).
"""

import asyncio
import json
import logging
import time
from typing import Awaitable, Callable

from db import list_active_documents
from config import MEETING_BOT_NAME, MEETING_WAKE_MODEL_PATH
from gemini_client import GeminiLiveClient
from pdf.digest import build_knowledge_context
from pdf.retrieval import retrieve_context
from .prompt import build_meeting_prompt
from .wake_gate import WakeGate, wake_variants

logger = logging.getLogger(__name__)

# Gemini entrega PCM16 mono a 24 kHz: 48 bytes por ms.
BOT_BYTES_PER_S = 24000 * 2
# Igual que MIC_REOPEN_GUARD_MS del cliente web (voice-client.ts).
MIC_REOPEN_GUARD_S = 0.5
# Reconexiones seguidas (sesiones que mueren en < RECONNECT_WINDOW_S) antes de
# rendirse y apagar el cerebro con error.
MAX_FAST_FAILURES = 3
RECONNECT_WINDOW_S = 30.0
_wake_model = None


def _new_wake_gate() -> WakeGate:
    global _wake_model
    from vosk import KaldiRecognizer, Model, SetLogLevel

    SetLogLevel(-1)
    if _wake_model is None:
        _wake_model = Model(MEETING_WAKE_MODEL_PATH)
    # Gramática cerrada: sin ella Vosk reparte el nombre entre todo su
    # vocabulario ("mangle", "más clara"...) y casi nunca sale "manglar".
    # Solo palabras del vocabulario del modelo; el resto Vosk lo descarta.
    phrases = [
        " ".join(words)
        for words in wake_variants(MEETING_BOT_NAME)
        if words and all(_wake_model.vosk_model_find_word(w) >= 0 for w in words)
    ]
    grammar = json.dumps(phrases + ["[unk]"])
    return WakeGate(KaldiRecognizer(_wake_model, 16000, grammar), MEETING_BOT_NAME)


class MeetingBrain:
    def __init__(
        self,
        *,
        on_bot_pcm: Callable[[bytes], Awaitable[None]],
        on_transcript: Callable[[str, str], Awaitable[None]],
        on_turn_complete: Callable[[], Awaitable[None]],
        on_interrupted: Callable[[], Awaitable[None]],
        on_fatal: Callable[[str], Awaitable[None]],
    ):
        self._on_bot_pcm = on_bot_pcm
        self._on_transcript = on_transcript
        self._on_turn_complete = on_turn_complete
        self._on_interrupted = on_interrupted
        self._on_fatal = on_fatal
        self._gemini: GeminiLiveClient | None = None
        self._task: asyncio.Task | None = None
        self._stopping = False
        self._knowledge = ""
        # Instante (monotonic) en que termina de sonar el audio ya enviado.
        self._play_until = 0.0
        self._wake_gate: WakeGate | None = None

    @property
    def active(self) -> bool:
        return self._task is not None and not self._stopping

    # -- ciclo de vida ---------------------------------------------------------
    async def start(self):
        self._stopping = False
        # Cargar el modelo local antes de abrir Gemini: si falta, no se activa
        # una sesión que pudiera recibir el audio sin filtro.
        self._wake_gate = _new_wake_gate()
        self._knowledge = await self._load_knowledge()
        # Sin presentación automática: las personas tienen la primera palabra.
        await self._connect()
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        self._stopping = True
        task, self._task = self._task, None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        await self._close_gemini()
        self._play_until = 0.0
        self._wake_gate = None

    async def _load_knowledge(self) -> str:
        try:
            docs = await list_active_documents()
            knowledge = await build_knowledge_context([d["id"] for d in docs])
            logger.info("[brain] conocimiento precargado: %d chars", len(knowledge))
            return knowledge
        except Exception as e:
            logger.warning("[brain] precarga de conocimiento falló: %s", e)
            return ""

    async def _connect(self):
        if self._wake_gate:
            self._wake_gate.reset()
        gemini = GeminiLiveClient()
        gemini.log_transcripts = False  # privacidad de los participantes
        gemini.transcript_callback = self._handle_transcript
        gemini.turn_complete_callback = self._on_turn_complete
        gemini.interrupt_callback = self._handle_interrupted
        gemini.on_user_turn_complete = self._run_retrieval
        await gemini.connect(system_prompt=build_meeting_prompt(self._knowledge))
        self._gemini = gemini
        logger.info("[brain] sesión Gemini abierta")

    async def _close_gemini(self):
        gemini, self._gemini = self._gemini, None
        if gemini:
            try:
                await gemini.close()
            except Exception as e:
                logger.debug("[brain] close: %s", e)

    async def _run(self):
        fast_failures = 0
        while not self._stopping:
            if self._gemini is None:
                try:
                    await self._connect()
                except Exception as e:
                    fast_failures += 1
                    logger.warning("[brain] reconexión falló (%d): %s", fast_failures, e)
                    if fast_failures > MAX_FAST_FAILURES:
                        await self._fatal(f"No se pudo reconectar con Gemini: {e}")
                        return
                    await asyncio.sleep(2 * fast_failures)
                    continue

            started = time.monotonic()
            try:
                async for chunk in self._gemini.receive_loop():
                    await self._emit_audio(chunk)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if not self._stopping:
                    logger.warning("[brain] sesión Gemini cayó: %s", e)
            if self._stopping:
                return

            await self._close_gemini()
            if time.monotonic() - started < RECONNECT_WINDOW_S:
                fast_failures += 1
            else:
                fast_failures = 1
            if fast_failures > MAX_FAST_FAILURES:
                await self._fatal("La sesión con Gemini se cayó repetidamente")
                return
            logger.info("[brain] reconectando sesión Gemini")
            await asyncio.sleep(1)

    async def _fatal(self, message: str):
        self._stopping = True
        self._task = None
        await self._close_gemini()
        try:
            await self._on_fatal(message)
        except Exception as e:
            logger.warning("[brain] on_fatal falló: %s", e)

    # -- entrada: audio de la reunión -----------------------------------------
    def _input_suppressed(self) -> bool:
        return time.monotonic() < self._play_until + MIC_REOPEN_GUARD_S

    async def feed_remote_pcm(self, pcm: bytes):
        gemini = self._gemini
        gate = self._wake_gate
        if not gemini or not gate or self._stopping:
            return
        if self._input_suppressed():
            gate.reset()
            return
        try:
            for chunk in gate.feed(pcm):
                await gemini.send_audio_pcm16_16k(chunk)
        except Exception as e:
            logger.debug("[brain] audio a Gemini no enviado: %s", e)

    # -- salida: voz y eventos de Manglara ------------------------------------
    async def _emit_audio(self, chunk: bytes):
        now = time.monotonic()
        self._play_until = max(self._play_until, now) + len(chunk) / BOT_BYTES_PER_S
        await self._on_bot_pcm(chunk)

    async def _handle_transcript(self, role: str, text: str):
        await self._on_transcript(role, text)

    async def _handle_interrupted(self):
        # El audio ya entregado queda obsoleto: la página lo descarta.
        self._play_until = 0.0
        await self._on_interrupted()

    async def _run_retrieval(self, text: str):
        gemini = self._gemini
        if not gemini or not text.strip():
            return
        try:
            docs = await list_active_documents()
            doc_ids = [d["id"] for d in docs]
            if not doc_ids:
                return
            context = await retrieve_context(doc_ids, text)
            if context:
                await gemini.inject_context(
                    "[Contexto recuperado automáticamente de las cartillas del "
                    "Currículo Verde; nadie en la reunión escribió esto. Úsalo para "
                    f"responder.]\n\n{context}"
                )
                logger.info("[brain] contexto RAG inyectado: %d chars", len(context))
        except Exception as e:
            logger.warning("[brain] RAG falló: %s", e)
