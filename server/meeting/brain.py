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
import logging
import time
from typing import Awaitable, Callable

from gemini_client import GeminiLiveClient
from pdf.digest import build_knowledge_context
from pdf.retrieval import retrieve_context
from pdf.router import get_active_documents
from .prompt import ACTIVATION_CUE, build_meeting_prompt

logger = logging.getLogger(__name__)

# Gemini entrega PCM16 mono a 24 kHz: 48 bytes por ms.
BOT_BYTES_PER_S = 24000 * 2
# Igual que MIC_REOPEN_GUARD_MS del cliente web (voice-client.ts).
MIC_REOPEN_GUARD_S = 0.5
# Reconexiones seguidas (sesiones que mueren en < RECONNECT_WINDOW_S) antes de
# rendirse y apagar el cerebro con error.
MAX_FAST_FAILURES = 3
RECONNECT_WINDOW_S = 30.0


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

    @property
    def active(self) -> bool:
        return self._task is not None and not self._stopping

    # -- ciclo de vida ---------------------------------------------------------
    async def start(self):
        self._stopping = False
        self._knowledge = await self._load_knowledge()
        await self._connect(greet=True)
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

    async def _load_knowledge(self) -> str:
        try:
            knowledge = await build_knowledge_context(get_active_documents())
            logger.info("[brain] conocimiento precargado: %d chars", len(knowledge))
            return knowledge
        except Exception as e:
            logger.warning("[brain] precarga de conocimiento falló: %s", e)
            return ""

    async def _connect(self, greet: bool):
        gemini = GeminiLiveClient()
        gemini.log_transcripts = False  # privacidad de los participantes
        gemini.transcript_callback = self._handle_transcript
        gemini.turn_complete_callback = self._on_turn_complete
        gemini.interrupt_callback = self._handle_interrupted
        gemini.on_user_turn_complete = self._run_retrieval
        await gemini.connect(system_prompt=build_meeting_prompt(self._knowledge))
        self._gemini = gemini
        logger.info("[brain] sesión Gemini abierta")
        if greet:
            await gemini.send_text(ACTIVATION_CUE)

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
                    await self._connect(greet=False)
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
        if not gemini or self._stopping or self._input_suppressed():
            return
        try:
            await gemini.send_audio_pcm16_16k(pcm)
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
        doc_ids = get_active_documents()
        gemini = self._gemini
        if not doc_ids or not gemini or not text.strip():
            return
        try:
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
