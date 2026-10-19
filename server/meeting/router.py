"""API de reuniones externas: REST + WS público para la UI.

La UI nunca habla con el browser: todos los comandos pasan por aquí.
"""

import asyncio
import logging
import re
import secrets

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, field_validator

from config import MEETING_BOT_NAME
from .bridge import BRIDGES, MeetingBridge
from .detector import UnsupportedMeetingUrl, detect_and_normalize
from .models import MeetingSession
from .recipes import get_recipe

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/meetings", tags=["meetings"])
# Los WS van sin prefijo: /ws/meetings/... (igual que /ws/voice).
ws_router = APIRouter(tags=["meetings"])

# Sesiones conocidas (activas e históricas recientes) y sus tasks.
SESSIONS: dict[str, MeetingSession] = {}
TASKS: dict[str, asyncio.Task] = {}
# Suscriptores UI por sesión.
SUBS: dict[str, set[WebSocket]] = {}

# v1: una sola reunión activa a la vez (un Chromium + una sesión Gemini).
BUSY_MESSAGE = (
    "Manglara ya está en una reunión. Desconéctala antes de unirla a otra."
)
# Historial de reuniones terminadas que se conserva (para GET y recargas).
MAX_FINISHED_SESSIONS = 20


def _prune_finished():
    finished = sorted(
        (s for s in SESSIONS.values() if s.bridge in ("closed", "error")),
        key=lambda s: s.created_at,
    )
    for s in finished[: max(0, len(finished) - MAX_FINISHED_SESSIONS)]:
        SESSIONS.pop(s.id, None)
        TASKS.pop(s.id, None)
        SUBS.pop(s.id, None)


# El WS interno solo acepta la página del Chromium local.
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}
# La página manda el token como subprotocolo ("manglara.bridge", "t.<token>")
# para que no aparezca en la URL (los access logs de uvicorn la imprimen).
BRIDGE_PROTOCOL = "manglara.bridge"


def _bridge_token(ws: WebSocket) -> str:
    offered = ws.headers.get("sec-websocket-protocol", "")
    for proto in (p.strip() for p in offered.split(",")):
        if proto.startswith("t."):
            return proto[2:]
    return ""


class JoinRequest(BaseModel):
    input: str = Field(..., min_length=3, max_length=500)
    name: str | None = Field(default=None, max_length=50)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str | None) -> str | None:
        # Se escribe en la UI de la reunión: sin caracteres de control.
        if v is None:
            return None
        v = re.sub(r"[\x00-\x1f\x7f]", "", v).strip()
        return v or None


class MediaToggle(BaseModel):
    enabled: bool


def _active_session() -> MeetingSession | None:
    for s in SESSIONS.values():
        if s.bridge not in ("closed", "error"):
            return s
    return None


def _get_or_404(session_id: str) -> MeetingSession:
    try:
        return SESSIONS[session_id]
    except KeyError:
        raise HTTPException(404, "Reunión no encontrada")


def _get_bridge_or_404(session_id: str) -> MeetingBridge:
    try:
        return BRIDGES[session_id]
    except KeyError:
        raise HTTPException(404, "Puente no activo para esta reunión")


async def _broadcast(session: MeetingSession):
    for ws in list(SUBS.get(session.id, set())):
        try:
            await ws.send_json({"type": "state", **session.public_state()})
        except Exception:
            pass


async def push_transcript(session_id: str, role: str, text: str):
    """Difunde transcripción a la UI (la usa Fase 2: Gemini)."""
    for ws in list(SUBS.get(session_id, set())):
        try:
            await ws.send_json(
                {"type": "transcript", "role": role, "text": text}
            )
        except Exception:
            pass


@router.post("/join", status_code=202)
async def join_meeting(req: JoinRequest):
    if _active_session():
        raise HTTPException(409, BUSY_MESSAGE)
    try:
        provider, url = detect_and_normalize(req.input)
    except UnsupportedMeetingUrl as e:
        raise HTTPException(422, str(e))

    _prune_finished()
    session = MeetingSession(
        provider=provider, url=url, name=req.name or MEETING_BOT_NAME
    )
    SESSIONS[session.id] = session
    logger.info("[meetings] join %s (%s)", session.id[:8], provider)

    async def on_event(s: MeetingSession):
        await _broadcast(s)

    async def on_transcript(role: str, text: str):
        await push_transcript(session.id, role, text)

    bridge = MeetingBridge(
        session,
        get_recipe(provider),
        on_event=on_event,
        on_transcript=on_transcript,
    )
    # Registrado ya (run() también lo hace): los comandos que lleguen antes
    # de que la task arranque no deben dar 404.
    BRIDGES[session.id] = bridge
    TASKS[session.id] = asyncio.create_task(bridge.run())
    return {"id": session.id, **session.public_state()}


@router.get("")
async def list_meetings():
    """Debug: la reunión activa (si hay) y el historial reciente."""
    active = _active_session()
    sessions = sorted(SESSIONS.values(), key=lambda s: s.created_at, reverse=True)
    return {
        "active": active.id if active else None,
        "sessions": [s.public_state() for s in sessions],
    }


@router.get("/{session_id}")
async def get_meeting(session_id: str):
    return _get_or_404(session_id).public_state()


@router.get("/{session_id}/debug/ui")
async def debug_meeting_ui(session_id: str, request: Request):
    """Mantenimiento de recetas: botones/campos visibles en la página del bot.

    Solo desde la máquina local (devuelve texto de la UI de la reunión).
    """
    if (request.client.host if request.client else "") not in _LOOPBACK:
        raise HTTPException(403, "Solo disponible en local")
    bridge = _get_bridge_or_404(session_id)
    page = bridge.browser.page
    if page is None:
        raise HTTPException(409, "El navegador de la reunión no está abierto")
    data = await page.evaluate(
        """() => {
          const vis = (el) => { const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0; };
          const label = (el) => (el.getAttribute('aria-label') || el.innerText ||
            el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
          const pick = (sel) => [...document.querySelectorAll(sel)]
            .filter(vis).map(label).filter(Boolean).slice(0, 80);
          return {
            title: document.title,
            buttons: pick('button, [role=button], a[role=link]'),
            inputs: pick('input, textarea'),
            text: (document.body ? document.body.innerText : '').slice(0, 1500),
          };
        }"""
    )
    data["recipe_state"] = await bridge.recipe.poll_state(page)
    data["bridge_stats"] = await page.evaluate(
        "() => window.__manglaraBridge && window.__manglaraBridge.stats()"
    )
    data["remote_pcm_bytes"] = bridge.remote_pcm_bytes
    return data


@router.post("/{session_id}/leave")
async def leave_meeting(session_id: str):
    bridge = _get_bridge_or_404(session_id)
    await bridge.leave()
    return {"ok": True}


@router.post("/{session_id}/brain/start")
async def brain_start(session_id: str):
    bridge = _get_bridge_or_404(session_id)
    try:
        await bridge.brain_start()
    except ValueError as e:
        raise HTTPException(409, str(e))
    except Exception:
        raise HTTPException(
            502, bridge.session.error or "No se pudo iniciar Gemini Live"
        )
    return {"ok": True, "brain": bridge.session.brain}


@router.post("/{session_id}/brain/stop")
async def brain_stop(session_id: str):
    bridge = _get_bridge_or_404(session_id)
    await bridge.brain_stop()
    return {"ok": True, "brain": bridge.session.brain}


@router.post("/{session_id}/mic")
async def set_mic(session_id: str, req: MediaToggle):
    bridge = _get_bridge_or_404(session_id)
    await bridge.set_mic(req.enabled)
    return {"ok": True, "mic_enabled": req.enabled}


@router.post("/{session_id}/cam")
async def set_cam(session_id: str, req: MediaToggle):
    bridge = _get_bridge_or_404(session_id)
    await bridge.set_cam(req.enabled)
    return {"ok": True, "cam_enabled": req.enabled}


@ws_router.websocket("/ws/meetings/{session_id}")
async def ws_meeting_ui(ws: WebSocket, session_id: str):
    """Eventos hacia la UI: state + (Fase 2) transcript."""
    try:
        session = SESSIONS[session_id]
    except KeyError:
        await ws.close(code=4404)
        return
    await ws.accept()
    SUBS.setdefault(session_id, set()).add(ws)
    await ws.send_json({"type": "state", **session.public_state()})
    try:
        async for _ in ws.iter_text():
            pass  # la UI solo escucha; keepalive
    except WebSocketDisconnect:
        pass
    finally:
        SUBS.get(session_id, set()).discard(ws)


@ws_router.websocket("/ws/meetings/{session_id}/bridge")
async def ws_meeting_bridge(ws: WebSocket, session_id: str):
    """WS interno: solo la página inyectada del browser (token + loopback)."""
    bridge = BRIDGES.get(session_id)
    if bridge is None:
        await ws.close(code=4404)
        return
    token = _bridge_token(ws)
    host = ws.client.host if ws.client else ""
    if host not in _LOOPBACK or not secrets.compare_digest(
        token, bridge.session.bridge_token
    ):
        logger.warning("[meetings] WS interno rechazado (%s)", session_id[:8])
        await ws.close(code=4403)
        return
    await bridge.handle_bridge_ws(ws, subprotocol=BRIDGE_PROTOCOL)
