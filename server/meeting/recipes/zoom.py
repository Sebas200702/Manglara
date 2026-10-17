"""Receta Zoom: join desde el cliente web del navegador.

Flujo: /j/<id> -> /wc/<id>/join -> nombre -> "Join" ->
sala de espera (el host admite) -> en reunión.
Última verificación: sin verificar (pendiente de reunión real).
"""

import logging
import re
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

from .base import (
    JoinRecipe,
    click_first,
    click_mic_button,
    fill_first,
)

logger = logging.getLogger(__name__)


class ZoomRecipe(JoinRecipe):
    provider = "zoom"
    last_verified = "sin verificar (pendiente de reunión real)"

    selectors = {
        "joining": [
            {"text": "Join from Your Browser"},
            {"text": "Your Name"},
            {"text": "Tu nombre"},
        ],
        "lobby": [
            {"text": "will let you in soon"},
            {"text": "te permitirá entrar pronto"},
            {"text": "Waiting Room"},
            {"text": "sala de espera"},
        ],
        "inMeeting": [
            {"text": "Mute microphone"},
            {"text": "Unmute microphone"},
            {"text": "Silenciar micrófono"},
        ],
        # Zoom web no muestra un aviso de "solo tú": sin auto-leave por
        # soledad (la salida por fin de reunión sí funciona).
        "alone": [],
        "left": [
            {"text": "You have left the meeting"},
            {"text": "Has salido de la reunión"},
            {"text": "This meeting has ended"},
            {"text": "reunión ha terminado"},
        ],
    }

    def entry_url(self, url: str) -> str:
        """/j/<id> -> /wc/<id>/join (conserva pwd). Otros links tal cual."""
        try:
            parts = urlparse(url)
            m = re.match(r"^/j/(\d+)", parts.path)
            if not m:
                return url
            query = dict(parse_qsl(parts.query))
            keep = {k: v for k, v in query.items() if k.lower() == "pwd"}
            return urlunparse(
                parts._replace(path=f"/wc/{m.group(1)}/join", query=urlencode(keep))
            )
        except Exception:
            return url

    async def join(self, page, name: str):
        await page.wait_for_timeout(3000)
        # Link intermedio "Join from Your Browser" (planes con SSO/app).
        await click_first(
            page,
            [{"text": "Join from Your Browser"}],
            timeout_ms=8000,
        )
        await page.wait_for_timeout(2000)
        filled = await fill_first(
            page,
            [
                {"text": "Your Name"},
                {"text": "Tu nombre"},
                {"label": "name"},
                {"label": "nombre"},
            ],
            name,
        )
        if not filled:
            logger.warning("[zoom] no se encontró el campo de nombre")
        joined = await click_first(
            page,
            [
                {"text": "Join"},
                {"text": "Unirse"},
            ],
        )
        if not joined:
            raise RuntimeError("no se encontró el botón Join")

    async def leave(self, page):
        await click_first(
            page,
            [
                {"text": "Leave"},
                {"text": "Salir"},
                {"text": "End"},
            ],
            timeout_ms=8000,
        )
        # Confirmación "Leave Meeting" si aparece.
        await click_first(
            page,
            [
                {"text": "Leave Meeting"},
                {"text": "Abandonar la reunión"},
            ],
            timeout_ms=5000,
        )

    async def set_mic(self, page, enabled: bool):
        await click_mic_button(
            page,
            enabled,
            when_muted=[
                {"text": "Unmute microphone"},
                {"text": "Activar micrófono"},
            ],
            when_live=[
                {"text": "Mute microphone"},
                {"text": "Silenciar micrófono"},
            ],
        )

    async def set_cam(self, page, enabled: bool):
        await click_first(
            page,
            [
                {"text": "Start Video" if enabled else "Stop Video"},
                {"text": "Iniciar vídeo" if enabled else "Detener vídeo"},
            ],
            timeout_ms=8000,
        )
