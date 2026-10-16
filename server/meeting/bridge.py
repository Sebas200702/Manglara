"""Orquestador de una sesión de reunión: browser + WS interno + eventos.

La receta del proveedor (recipes/, T1.6) se inyecta como dependencia para
el join y los clicks en la UI de la reunión. Este módulo no sabe de Teams,
Zoom ni Meet.
"""

import asyncio
import base64
import json
import logging
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from fastapi import WebSocket, WebSocketDisconnect

from config import MEETING_MAX_DURATION_MIN, PORT
from .browser import MeetingBrowser
from .models import MeetingSession

if TYPE_CHECKING:
    from .recipes.base import JoinRecipe

logger = logging.getLogger(__name__)

# Sesiones vivas por id. El router (T1.7) resuelve el WS interno aquí.
BRIDGES: dict[str, "MeetingBridge"] = {}

POLL_INTERVAL_S = 2.0


class JoinError(RuntimeError):
    pass


class MeetingBridge:
    def __init__(
        self,
        session: MeetingSession,
        recipe: "JoinRecipe",
        on_event: Callable[[MeetingSession], Awaitable[None]] | None = None,
        on_remote_pcm: Callable[[bytes], Awaitable[None]] | None = None,
    ):
        self.session = session
        self.recipe = recipe
        self.on_event = on_event
        self.on_remote_pcm = on_remote_pcm
        self.browser = MeetingBrowser()
        self._page_ws: WebSocket | None = None
        self._closing = False
        self._max_duration_task: asyncio.Task | None = None

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
        try:
            self._set_bridge("launching")
            await self._emit()
            ws_url = f"ws://127.0.0.1:{PORT}/ws/meetings/{s.id}/bridge"
            await self.browser.launch(ws_url, s.id, self.recipe.selectors)
            # Mic falso arranca mudo: entra dormida por defecto.
            await self._send_control({"type": "set_mic", "enabled": False})

            self._set_bridge("joining")
            await self._emit()
            entry = self.recipe.entry_url(s.url)
            logger.info("[meeting] navegando a reunión (%s)", s.provider)
            await self.browser.page.goto(entry, timeout=60000)
            try:
                await self.recipe.join(self.browser.page, s.name)
            except Exception as e:
                raise JoinError(f"join falló: {e}")

            self._max_duration_task = asyncio.create_task(self._max_duration())
            await self._poll_loop()
        except JoinError as e:
            s.error = str(e)[:300]
            self._set_bridge("error")
            await self._emit()
            logger.error("[meeting] %s: %s", s.id[:8], e)
        except Exception as e:
            s.error = str(e)[:300]
            self._set_bridge("error")
            await self._emit()
            logger.exception("[meeting] %s error inesperado", s.id[:8])
        finally:
            await self._cleanup()
            BRIDGES.pop(s.id, None)

    async def _poll_loop(self):
        s = self.session
        while not self._closing:
            await asyncio.sleep(POLL_INTERVAL_S)
            try:
                state = await self.recipe.poll_state(self.browser.page)
            except Exception as e:
                logger.warning("[meeting] poll falló: %s", e)
                continue
            if state == "in_meeting" and s.bridge != "in_meeting":
                self._set_bridge("in_meeting")
                await self._emit()
            elif state == "lobby" and s.bridge != "lobby":
                self._set_bridge("lobby")
                await self._emit()
            elif state == "left":
                logger.info("[meeting] la página reporta salida")
                await self.leave()
                return

    async def _max_duration(self):
        await asyncio.sleep(MEETING_MAX_DURATION_MIN * 60)
        if not self._closing:
            logger.info("[meeting] duración máxima alcanzada")
            self.session.error = "Duración máxima de la reunión alcanzada"
            await self.leave()

    async def leave(self, reason: str = "user"):
        if self._closing:
            return
        self._closing = True
        logger.info("[meeting] leave (%s)", reason)
        self._set_bridge("leaving")
        await self._emit()
        try:
            await self._send_control({"type": "bye"})
            if self.browser.page:
                try:
                    await self.recipe.leave(self.browser.page)
                except Exception as e:
                    logger.warning("[meeting] recipe.leave falló: %s", e)
        finally:
            if self.session.bridge != "error":
                self._set_bridge("closed")
            await self._emit()

    async def _cleanup(self):
        if self._max_duration_task and not self._max_duration_task.done():
            self._max_duration_task.cancel()
        await self.browser.close()

    # -- controles de media --------------------------------------------------
    async def set_mic(self, enabled: bool):
        self.session.media.mic_enabled = enabled
        await self._send_control({"type": "set_mic", "enabled": enabled})
        try:
            await self.recipe.set_mic(self.browser.page, enabled)
        except Exception as e:
            logger.warning("[meeting] set_mic receta falló: %s", e)
        await self._emit()

    async def set_cam(self, enabled: bool):
        self.session.media.cam_enabled = enabled
        await self._send_control({"type": "set_cam", "enabled": enabled})
        try:
            await self.recipe.set_cam(self.browser.page, enabled)
        except Exception as e:
            logger.warning("[meeting] set_cam receta falló: %s", e)
        await self._emit()

    # -- WS interno (página inyectada <-> backend) -----------------------------
    async def handle_bridge_ws(self, ws: WebSocket):
        await ws.accept()
        if self._page_ws:
            logger.warning("[meeting] WS interno duplicado, reemplazo")
        self._page_ws = ws
        logger.info("[meeting] WS interno conectado")
        try:
            async for raw in ws.iter_text():
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

    async def _on_page_message(self, msg: dict):
        mtype = msg.get("type")
        if mtype == "remote_pcm":
            if self.on_remote_pcm and msg.get("data"):
                try:
                    pcm = base64.b64decode(msg["data"])
                    await self.on_remote_pcm(pcm)
                except Exception as e:
                    logger.warning("[meeting] pcm inválido: %s", e)
        elif mtype == "meeting_state":
            state = msg.get("state")
            s = self.session
            # La página es señal suplementaria; la receta manda (poll_loop).
            if state == "left" and s.bridge == "in_meeting":
                logger.info("[meeting] página reporta left")
                await self.leave(reason="page_left")
        elif mtype == "log":
            logger.debug("[meeting:page] %s", str(msg.get("text"))[:200])
        # ready / gum_called: solo telemetría por ahora.
        elif mtype in ("ready", "gum_called"):
            logger.debug("[meeting:page] %s %s", mtype, msg.get("state", ""))

    async def _send_control(self, msg: dict):
        if not self._page_ws:
            return
        try:
            await self._page_ws.send_json(msg)
        except Exception as e:
            logger.warning("[meeting] control no enviado: %s", e)

    # -- salida hacia Gemini (Fase 2) ------------------------------------------
    async def send_bot_pcm(self, pcm: bytes):
        if not pcm or not self._page_ws:
            return
        b64 = base64.b64encode(pcm).decode()
        await self._send_control({"type": "bot_pcm", "data": b64})

    def get_debug_info(self) -> dict[str, Any]:
        return {
            **self.session.public_state(),
            "ws_connected": self._page_ws is not None,
        }
