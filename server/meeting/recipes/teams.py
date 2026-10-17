"""Receta Teams: join como invitado desde el navegador.

Flujo: "Continuar en este navegador" -> nombre -> "Unirse ahora" ->
sala de espera (el host admite) -> en reunión.
Última verificación: sin verificar (pendiente de reunión real).
"""

import logging

from .base import (
    JoinRecipe,
    click_first,
    click_mic_button,
    fill_first,
)

logger = logging.getLogger(__name__)


class TeamsRecipe(JoinRecipe):
    provider = "teams"
    last_verified = "sin verificar (pendiente de reunión real)"

    selectors = {
        "joining": [
            {"text": "Continuar en este explorador"},
            {"text": "Continue on this browser"},
            {"text": "Escribe tu nombre"},
            {"text": "Type your name"},
        ],
        "lobby": [
            {"text": "sala de espera"},
            {"text": "lobby"},
            {"text": "will let you in soon"},
            {"text": "te permitirá entrar pronto"},
        ],
        "inMeeting": [
            {"text": "Abandonar"},
            {"text": "Leave"},
        ],
        "alone": [
            {"text": "Esperando a que otros se unan"},
            {"text": "Waiting for others to join"},
        ],
        "left": [
            {"text": "Has abandonado la reunión"},
            {"text": "You left the meeting"},
            {"text": "Se ha acabado la reunión"},
            {"text": "meeting has ended"},
        ],
    }

    async def join(self, page, name: str):
        # 1. "Continuar en este navegador" (evita la app de escritorio).
        await click_first(
            page,
            [
                {"text": "Continuar en este explorador"},
                {"text": "Continue on this browser"},
            ],
        )
        await page.wait_for_timeout(3000)
        # 2. Nombre de invitado.
        filled = await fill_first(
            page,
            [
                {"text": "Escribe tu nombre"},
                {"text": "Type your name"},
                {"label": "nombre"},
                {"label": "name"},
            ],
            name,
        )
        if not filled:
            logger.warning("[teams] no se encontró el campo de nombre")
        # 3. Unirse (entra a sala de espera si el host la exige).
        joined = await click_first(
            page,
            [
                {"text": "Unirse ahora"},
                {"text": "Join now"},
            ],
        )
        if not joined:
            raise RuntimeError("no se encontró el botón Unirse ahora")

    async def leave(self, page):
        await click_first(
            page,
            [
                {"text": "Abandonar"},
                {"text": "Leave"},
            ],
            timeout_ms=8000,
        )

    async def set_mic(self, page, enabled: bool):
        await click_mic_button(
            page,
            enabled,
            when_muted=[
                {"text": "Activar micrófono"},
                {"text": "Unmute"},
            ],
            when_live=[
                {"text": "Silenciar"},
                {"text": "Mute"},
            ],
        )

    async def set_cam(self, page, enabled: bool):
        await click_first(
            page,
            [
                {"text": "Activar cámara" if enabled else "Desactivar cámara"},
                {"text": "Turn camera on" if enabled else "Turn camera off"},
            ],
            timeout_ms=8000,
            # "Activar cámara" está contenido en "Desactivar cámara".
            anchored=True,
        )
