"""Receta Meet: join como invitado o con perfil logueado.

Flujo: nombre -> "Pedir unirse" (invitado) o "Unirme ahora" ->
espera de admisión (el host admite) -> en reunión.
Nota: sin cuenta Google solo funciona si el organizador permite invitados.
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


class MeetRecipe(JoinRecipe):
    provider = "meet"
    last_verified = "sin verificar (pendiente de reunión real)"

    selectors = {
        "joining": [
            {"text": "Tu nombre"},
            {"text": "Your name"},
            {"text": "Pedir unirse"},
            {"text": "Ask to join"},
        ],
        "lobby": [
            {"text": "Esperando a que te admitan"},
            {"text": "Waiting to be let in"},
            {"text": "Asking to join"},
            {"text": "Pidiendo unirse"},
        ],
        "inMeeting": [
            {"text": "Desactivar micrófono"},
            {"text": "Activar micrófono"},
            {"text": "Turn off microphone"},
            {"text": "Turn on microphone"},
        ],
        "alone": [
            {"text": "Eres la única persona aquí"},
            {"text": "You're the only one here"},
            {"text": "No hay nadie más"},
        ],
        "left": [
            {"text": "Has salido de la reunión"},
            {"text": "You left the meeting"},
            {"text": "reunión ha terminado"},
            {"text": "meeting has ended"},
        ],
    }

    async def join(self, page, name: str):
        await page.wait_for_timeout(3000)
        filled = await fill_first(
            page,
            [
                {"text": "Tu nombre"},
                {"text": "Your name"},
                {"label": "nombre"},
                {"label": "name"},
            ],
            name,
        )
        if not filled:
            logger.warning("[meet] no se encontró el campo de nombre")
        joined = await click_first(
            page,
            [
                {"text": "Pedir unirse"},
                {"text": "Ask to join"},
                {"text": "Unirme ahora"},
                {"text": "Join now"},
            ],
        )
        if not joined:
            raise RuntimeError("no se encontró el botón de unirse")

    async def leave(self, page):
        await click_first(
            page,
            [
                {"text": "Salir de la llamada"},
                {"text": "Leave call"},
            ],
            timeout_ms=8000,
        )

    async def set_mic(self, page, enabled: bool):
        await click_mic_button(
            page,
            enabled,
            when_muted=[
                {"text": "Activar micrófono"},
                {"text": "Turn on microphone"},
            ],
            when_live=[
                {"text": "Desactivar micrófono"},
                {"text": "Turn off microphone"},
            ],
        )

    async def set_cam(self, page, enabled: bool):
        await click_first(
            page,
            [
                {"text": "Activar cámara" if enabled else "Desactivar cámara"},
                {"text": "Turn on camera" if enabled else "Turn off camera"},
            ],
            timeout_ms=8000,
        )
