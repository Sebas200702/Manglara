"""Orquestador de una sesión de reunión: browser + WS interno + eventos.

La receta del proveedor (recipes/, T1.6) se inyecta como dependencia para
el join y los clicks en la UI de la reunión. Este módulo no sabe de Teams,
Zoom ni Meet.

El cerebro (Gemini Live, brain.py) es opcional y se enciende/apaga dentro de
la reunión: Manglara entra "dormida" y solo escucha/habla tras brain_start().
"""

import asyncio
import base64
import json
import logging
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from fastapi import WebSocket, WebSocketDisconnect

from config import MEETING_ALONE_TIMEOUT_MIN, MEETING_MAX_DURATION_MIN, PORT
from .brain import MeetingBrain
from .browser import MeetingBrowser
from .detector import redact_urls
from .models import EndReason, MeetingSession

if TYPE_CHECKING:
    from .recipes.base import JoinRecipe

logger = logging.getLogger(__name__)

# Sesiones vivas por id. El router (T1.7) resuelve el WS interno aquí.
BRIDGES: dict[str, "MeetingBridge"] = {}

POLL_INTERVAL_S = 2.0
# "¿Está sola?" relee el DOM entero de la reunión; con un timeout de minutos
# basta mirarlo cada pocos polls (10 s) en vez de en cada uno.
ALONE_CHECK_EVERY = 5
# WS interno (página inyectada) caído más de esto -> 1 reintento -> error.
WS_DEAD_S = 30.0


class JoinError(RuntimeError):
    pass


class MeetingBridge:
    def __init__(
        self,
        session: MeetingSession,
        recipe: "JoinRecipe",
        on_event: Callable[[MeetingSession], Awaitable[None]] | None = None,
        on_remote_pcm: Callable[[bytes], Awaitable[None]] | None = None,
        on_transcript: Callable[[str, str], Awaitable[None]] | None = None,
    ):
        self.session = session
        self.recipe = recipe
        self.on_event = on_event
        self.on_remote_pcm = on_remote_pcm
        # (role, text) con role "participant" | "manglara".
        self.on_transcript = on_transcript
        self.browser = MeetingBrowser()
        self.brain: MeetingBrain | None = None
        self._brain_lock = asyncio.Lock()
        self._page_ws: WebSocket | None = None
        self._closing = False
        self._max_duration_task: asyncio.Task | None = None
        self._lost = asyncio.Event()
        self._left = asyncio.Event()
        # Watchdog del WS interno: desde cuándo está caído (None = conectado
        # o aún sin página) y si ya se gastó el reintento.
        self._ws_down_since: float | None = None
        self._ws_retried = False
        self._alone_since: float | None = None
        self._polls = 0
        # Diagnóstico: audio de participantes recibido de la página.
        self.remote_pcm_bytes = 0

    # -- eventos hacia la UI -------------------------------------------------
    async def _emit(self):
        if self.on_event:
            try:
                await self.on_event(self.session)
            except Exception as e:
                logger.warning("[meeting] on_event falló: %s", e)

    def _set_bridge(self, state):
        if self.session.bridge != state:
            self.session.bridge = state
            logger.info("[meeting] %s bridge=%s", self.session.id[:8], state)

    # -- ciclo de vida -------------------------------------------------------
    async def run(self):
        s = self.session
        BRIDGES[s.id] = self
        self.browser.on_lost = self._on_browser_lost
        try:
            self._set_bridge("launching")
            await self._emit()
            ws_url = f"ws://127.0.0.1:{PORT}/ws/meetings/{s.id}/bridge"
            await self.browser.launch(
                ws_url, s.id, self.recipe.selectors, ws_token=s.bridge_token
            )
            # Mic falso arranca mudo: entra dormida por defecto.
            await self._send_control({"type": "set_mic", "enabled": False})

            self._set_bridge("joining")
            await self._emit()
            self._ws_down_since = time.monotonic()
            entry = self.recipe.entry_url(s.url)
            logger.info("[meeting] navegando a reunión (%s)", s.provider)
            # "load" puede no llegar nunca en las SPA de los proveedores
            # (Teams deja peticiones colgadas); la receta espera sus botones.
            await self.browser.page.goto(
                entry, timeout=60000, wait_until="domcontentloaded"
            )
            try:
                await self.recipe.join(self.browser.page, s.name)
            except Exception as e:
                raise JoinError(f"No se pudo unir a la reunión: {e}")

            self._max_duration_task = asyncio.create_task(self._max_duration())
            await self._poll_loop()
            # leave() pedida desde la API corre en otra task: no cerrar el
            # browser mientras todavía está pulsando "Salir" en la reunión.
            if s.bridge == "leaving":
                try:
                    await asyncio.wait_for(self._left.wait(), 30)
                except asyncio.TimeoutError:
                    logger.warning("[meeting] leave tardó demasiado; cerrando")
        except JoinError as e:
            await self._fail(str(e))
        except Exception as e:
            if self.browser.lost_reason:
                await self._fail(self._lost_message())
            else:
                # Sin traceback en INFO: los mensajes de Playwright traen la
                # URL de la reunión (redactada abajo); el detalle va en DEBUG.
                logger.debug("[meeting] %s traceback", s.id[:8], exc_info=True)
                await self._fail(f"Error inesperado: {e}")
        finally:
            await self._cleanup()
            if s.ended_at is None:
                s.ended_at = time.time()
            BRIDGES.pop(s.id, None)

    def _on_browser_lost(self, reason: str):
        # Callback síncrono de Playwright: solo despierta al poll loop.
        self._lost.set()

    def _lost_message(self) -> str:
        reason = self.browser.lost_reason or "motivo desconocido"
        return f"Se perdió el navegador de la reunión ({reason})"

    async def _fail(self, message: str):
        """Termina en estado error, sin clicks en la UI de la reunión."""
        s = self.session
        if s.bridge in ("closed", "error"):
            return
        self._closing = True
        await self.brain_stop(emit=False)
        s.error = redact_urls(message)[:300]
        self._set_bridge("error")
        logger.error("[meeting] %s: %s", s.id[:8], s.error)
        await self._emit()

    async def _poll_loop(self):
        s = self.session
        while not self._closing:
            try:
                await asyncio.wait_for(self._lost.wait(), POLL_INTERVAL_S)
            except asyncio.TimeoutError:
                pass
            if self._closing:
                return
            if self._lost.is_set():
                await self._fail(self._lost_message())
                return
            if await self._watchdog_expired():
                return

            try:
                state = await self.recipe.poll_state(self.browser.page)
            except Exception as e:
                logger.warning("[meeting] poll falló: %s", redact_urls(str(e)))
                continue
            if state == "in_meeting" and s.bridge != "in_meeting":
                self._set_bridge("in_meeting")
                await self._emit()
                # El proveedor puede meterla con el micro abierto: alinear su UI
                # con el estado del bot (dormida = muda).
                await self.set_mic(s.media.mic_enabled)
            elif state == "lobby" and s.bridge != "lobby":
                self._set_bridge("lobby")
                await self._emit()
            elif state == "left":
                logger.info("[meeting] la reunión terminó o la sacaron")
                await self.leave(reason="ended")
                return

            self._polls += 1
            if (
                s.bridge == "in_meeting"
                and self._polls % ALONE_CHECK_EVERY == 0
                and await self._alone_expired()
            ):
                logger.info("[meeting] sola en la reunión: saliendo")
                await self.leave(reason="alone")
                return

    async def _watchdog_expired(self) -> bool:
        """WS interno caído > WS_DEAD_S: 1 reintento, luego error."""
        if self._page_ws is not None or self._ws_down_since is None:
            return False
        down = time.monotonic() - self._ws_down_since
        if down < WS_DEAD_S:
            return False
        if not self._ws_retried:
            self._ws_retried = True
            self._ws_down_since = time.monotonic()
            # El script de la página reintenta solo cada 3 s; si la página
            # responde, darle otra ventana completa antes de rendirse.
            try:
                await asyncio.wait_for(self.browser.page.evaluate("1"), 5)
                logger.warning(
                    "[meeting] WS interno caído %ds; página viva, reintento",
                    int(down),
                )
                return False
            except Exception:
                pass
        await self._fail("Se perdió la conexión con la página de la reunión")
        return True

    async def _alone_expired(self) -> bool:
        if MEETING_ALONE_TIMEOUT_MIN <= 0:
            return False
        try:
            alone = await self.recipe.is_alone(self.browser.page)
        except Exception:
            alone = False
        if not alone:
            self._alone_since = None
            return False
        now = time.monotonic()
        if self._alone_since is None:
            self._alone_since = now
            logger.info("[meeting] sin otros participantes")
        return now - self._alone_since >= MEETING_ALONE_TIMEOUT_MIN * 60

    async def _max_duration(self):
        await asyncio.sleep(MEETING_MAX_DURATION_MIN * 60)
        if not self._closing:
            logger.info("[meeting] duración máxima alcanzada")
            await self.leave(reason="max_duration")

    async def leave(self, reason: EndReason = "user"):
        if self._closing:
            return
        self._closing = True
        logger.info("[meeting] leave (%s)", reason)
        self.session.end_reason = reason
        self._set_bridge("leaving")
        await self._emit()
        await self.brain_stop(emit=False)
        try:
            await self._send_control({"type": "bye"})
            # Si la reunión ya terminó o el browser murió no hay botón que pulsar.
            if self.browser.alive and reason != "ended":
                try:
                    await self.recipe.leave(self.browser.page)
                except Exception as e:
                    logger.warning(
                        "[meeting] recipe.leave falló: %s", redact_urls(str(e))
                    )
        finally:
            if self.session.bridge != "error":
                self._set_bridge("closed")
            self.session.ended_at = time.time()
            self._left.set()
            await self._emit()

    async def _cleanup(self):
        if self._max_duration_task and not self._max_duration_task.done():
            self._max_duration_task.cancel()
        await self.brain_stop(emit=False)
        await self.browser.close()

    # -- cerebro (Gemini Live on/off) -----------------------------------------
    async def brain_start(self):
        """Activa la interacción. Solo dentro de la reunión."""
        s = self.session
        async with self._brain_lock:
            if s.bridge != "in_meeting":
                raise ValueError("Manglara aún no está dentro de la reunión")
            if s.brain in ("starting", "active"):
                return
            s.brain = "starting"
            s.error = None
            await self._emit()
            # Su voz hacia la reunión se abre ANTES de conectar: la presentación
            # llega en < 1 s y el click en el botón de mic puede tardar más.
            # (Silenciar la vuelve a cerrar.)
            await self.set_mic(True, emit=False)
            brain = MeetingBrain(
                on_bot_pcm=self.send_bot_pcm,
                on_transcript=self._brain_transcript,
                on_turn_complete=self._brain_turn_complete,
                on_interrupted=self._brain_interrupted,
                on_fatal=self._brain_fatal,
            )
            try:
                await brain.start()
            except Exception as e:
                await brain.stop()
                s.brain = "off"
                s.error = f"No se pudo iniciar la interacción: {str(e)[:200]}"
                logger.error("[meeting] brain_start falló: %s", e)
                await self.set_mic(False)
                raise
            self.brain = brain
            s.brain = "active"
            logger.info("[meeting] %s brain=active", s.id[:8])
        await self._send_control({"type": "set_listen", "enabled": True})
        await self._send_control({"type": "avatar_state", "state": "listening"})
        await self._emit()

    async def brain_stop(self, emit: bool = True):
        """Apaga la interacción: cierra Gemini y silencia. Sigue en la reunión."""
        s = self.session
        async with self._brain_lock:
            brain, self.brain = self.brain, None
            if not brain and s.brain == "off":
                return
            s.brain = "stopping"
            if emit:
                await self._emit()
            if brain:
                await brain.stop()
            s.brain = "off"
            logger.info("[meeting] %s brain=off", s.id[:8])
        # Dormida nadie consume el audio de la reunión: la página deja de
        # capturarlo y enviarlo.
        await self._send_control({"type": "set_listen", "enabled": False})
        await self._send_control({"type": "flush"})
        await self._send_control({"type": "avatar_state", "state": "idle"})
        if self._closing or not self.browser.page:
            # Saliendo: basta con cerrar el track falso, sin clicks en la UI.
            s.media.mic_enabled = False
            await self._send_control({"type": "set_mic", "enabled": False})
            if emit:
                await self._emit()
        else:
            await self.set_mic(False, emit=emit)

    async def _brain_transcript(self, role: str, text: str):
        public_role = "manglara" if role == "model" else "participant"
        if public_role == "manglara":
            # Lipsync del avatar dentro de la reunión.
            await self._send_control({"type": "lip_text", "text": text})
        if self.on_transcript:
            try:
                await self.on_transcript(public_role, text)
            except Exception as e:
                logger.warning("[meeting] on_transcript falló: %s", e)

    async def _brain_turn_complete(self):
        await self._send_control({"type": "turn_end"})

    async def _brain_interrupted(self):
        # Barge-in: el audio ya entregado a la página queda obsoleto.
        await self._send_control({"type": "flush"})

    async def _brain_fatal(self, message: str):
        logger.error("[meeting] cerebro apagado por error: %s", message)
        self.brain = None
        self.session.brain = "off"
        self.session.error = message
        await self._send_control({"type": "set_listen", "enabled": False})
        await self._send_control({"type": "flush"})
        await self._send_control({"type": "avatar_state", "state": "idle"})
        await self.set_mic(False)

    # -- controles de media --------------------------------------------------
    async def set_mic(self, enabled: bool, emit: bool = True):
        self.session.media.mic_enabled = enabled
        await self._send_control({"type": "set_mic", "enabled": enabled})
        try:
            await self.recipe.set_mic(self.browser.page, enabled)
        except Exception as e:
            logger.warning("[meeting] set_mic receta falló: %s", redact_urls(str(e)))
        if emit:
            await self._emit()

    async def set_cam(self, enabled: bool):
        self.session.media.cam_enabled = enabled
        await self._send_control({"type": "set_cam", "enabled": enabled})
        try:
            await self.recipe.set_cam(self.browser.page, enabled)
        except Exception as e:
            logger.warning("[meeting] set_cam receta falló: %s", redact_urls(str(e)))
        await self._emit()

    # -- WS interno (página inyectada <-> backend) -----------------------------
    async def handle_bridge_ws(self, ws: WebSocket, subprotocol: str | None = None):
        await ws.accept(subprotocol=subprotocol)
        if self._page_ws:
            logger.warning("[meeting] WS interno duplicado, reemplazo")
        self._page_ws = ws
        self._ws_down_since = None
        self._ws_retried = False
        logger.info("[meeting] WS interno conectado")
        try:
            while True:
                frame = await ws.receive()
                if frame["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect(frame.get("code", 1000))
                # Binario = PCM remoto crudo (sin base64 ni JSON); texto = control.
                data = frame.get("bytes")
                if data is not None:
                    await self._on_remote_pcm(data)
                    continue
                raw = frame.get("text")
                if raw is None:
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._on_page_message(msg)
        except WebSocketDisconnect:
            logger.info("[meeting] WS interno desconectado (reintenta la página)")
        except Exception as e:
            logger.warning("[meeting] WS interno error: %s", e)
        finally:
            if self._page_ws is ws:
                self._page_ws = None
                if not self._closing:
                    self._ws_down_since = time.monotonic()

    async def _on_page_message(self, msg: dict):
        mtype = msg.get("type")
        if mtype == "remote_pcm":
            # Formato anterior (base64 en JSON); la página actual manda binario.
            if not msg.get("data"):
                return
            try:
                pcm = base64.b64decode(msg["data"])
            except Exception as e:
                logger.warning("[meeting] pcm inválido: %s", e)
                return
            await self._on_remote_pcm(pcm)
        elif mtype == "meeting_state":
            state = msg.get("state")
            s = self.session
            # La página es señal suplementaria; la receta manda (poll_loop).
            if state == "left" and s.bridge == "in_meeting":
                logger.info("[meeting] página reporta left")
                await self.leave(reason="ended")
        elif mtype == "log":
            logger.debug("[meeting:page] %s", str(msg.get("text"))[:200])
        elif mtype == "ready":
            # Página nueva o WS reconectado: re-sincronizar su estado local.
            m = self.session.media
            await self._send_control({"type": "set_mic", "enabled": m.mic_enabled})
            await self._send_control({"type": "set_cam", "enabled": m.cam_enabled})
            await self._send_control(
                {"type": "set_listen", "enabled": self.brain is not None}
            )
            await self._send_control(
                {
                    "type": "avatar_state",
                    "state": "listening" if self.brain else "idle",
                }
            )
        elif mtype == "avatar_ready":
            logger.info("[meeting] avatar listo en la cámara")
        elif mtype == "avatar_timeout":
            logger.warning(
                "[meeting] el avatar no envió frames en 5 s: cámara con logo"
            )
        elif mtype == "tee":
            logger.info(
                "[meeting] audio remoto enganchado (%s), pistas=%s",
                msg.get("source"),
                msg.get("tracks"),
            )
        elif mtype == "gum_called":
            logger.debug("[meeting:page] gum_called")

    async def _on_remote_pcm(self, pcm: bytes):
        if not pcm:
            return
        self.remote_pcm_bytes += len(pcm)
        if self.brain:
            await self.brain.feed_remote_pcm(pcm)
        if self.on_remote_pcm:
            try:
                await self.on_remote_pcm(pcm)
            except Exception as e:
                logger.warning("[meeting] on_remote_pcm falló: %s", e)

    async def _send_control(self, msg: dict):
        if not self._page_ws:
            return
        try:
            await self._page_ws.send_json(msg)
        except Exception as e:
            logger.warning("[meeting] control no enviado: %s", e)

    # -- salida hacia Gemini (Fase 2) ------------------------------------------
    async def send_bot_pcm(self, pcm: bytes):
        # Binario: ni base64 (+33 % de bytes) ni JSON, y la página lo convierte
        # a Float32 sin decodificar texto.
        if not pcm or not self._page_ws:
            return
        await self._send_audio(pcm)

    async def _send_audio(self, pcm: bytes):
        try:
            await self._page_ws.send_bytes(pcm)
        except Exception as e:
            logger.warning("[meeting] audio no enviado: %s", e)

    def get_debug_info(self) -> dict[str, Any]:
        return {
            **self.session.public_state(),
            "ws_connected": self._page_ws is not None,
        }
