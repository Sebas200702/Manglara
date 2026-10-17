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
    set_toggle,
    fill_first,
    press_until_gone,
)

logger = logging.getLogger(__name__)


class TeamsRecipe(JoinRecipe):
    provider = "teams"
    last_verified = "2026-10-17 (join invitado /meet/<id>, lobby, en reunión)"

    selectors = {
        "joining": [
            {"text": "Continuar en este explorador"},
            {"text": "Continuar en este navegador"},
            {"text": "Continue on this browser"},
            {"text": "Escribe tu nombre"},
            {"text": "Escriba su nombre"},
            {"text": "Type your name"},
        ],
        "lobby": [
            # Verificado 2026-10-17 (Teams web, es): "Hola, Manglara. Alguien le
            # permitirá entrar en breve."
            {"text": "le permitirá entrar"},
            {"text": "Hemos notificado a las personas de la reunión"},
            {"text": "sala de espera"},
            {"text": "will let you in soon"},
            {"text": "te permitirá entrar pronto"},
        ],
        "inMeeting": [
            # Barra de la reunión: botón Salir (verificado 2026-10-17).
            {"selector": '[data-tid="hangup-main-btn"]'},
            {"selector": '#hangup-button'},
            {"selector": 'button[aria-label="Salir"]'},
            {"selector": 'button[aria-label="Leave"]'},
            {"selector": 'button[aria-label^="Abandonar"]'},
        ],
        "alone": [
            {"text": "Esperando a que otros se unan"},
            {"text": "Waiting for others to join"},
        ],
        "left": [
            # Verificado 2026-10-17: al expulsar al bot.
            {"text": "Se le ha quitado de la reunión"},
            {"text": "You've been removed from this meeting"},
            {"text": "Volver a unirse"},
            {"text": "Rejoin"},
            {"text": "Has abandonado la reunión"},
            {"text": "You left the meeting"},
            {"text": "Se ha acabado la reunión"},
            {"text": "meeting has ended"},
        ],
    }

    async def join(self, page, name: str):
        # 1. "Continuar en este explorador" (evita la app de escritorio).
        await press_until_gone(
            page,
            [
                {"selector": '[data-tid="joinOnWeb"]'},
                {"text": "Unirse a la reunión desde este explorador"},
                {"text": "Continuar en este explorador"},
                {"text": "Continuar en este navegador"},
                {"text": "Join meeting from this browser"},
                {"text": "Continue on this browser"},
                {"text": "Join on the web instead"},
            ],
            dom_selector='[data-tid="joinOnWeb"]',
            dom_text=r"explorador|navegador|browser",
        )
        # 2. Nombre de invitado.
        name_fields = [
            {"text": "Escribe tu nombre"},
            {"text": "Escriba su nombre"},
            {"text": "Type your name"},
            {"label": "nombre"},
            {"label": "name"},
        ]
        filled = await fill_first(page, name_fields, name)
        if not filled:
            logger.warning("[teams] no se encontró el campo de nombre")
        # 3. Unirse (entra a sala de espera si el host la exige).
        joined = await press_until_gone(
            page,
            [
                {"selector": '[data-tid="prejoin-join-button"]'},
                {"text": "Unirse ahora", "exact": True},
                {"text": "Join now", "exact": True},
            ],
            dom_selector='[data-tid="prejoin-join-button"]',
            dom_text=r"^\s*(Unirse ahora|Join now)\s*$",
        )
        if not joined:
            raise RuntimeError("no se encontró el botón Unirse ahora")

    async def leave(self, page):
        await click_first(
            page,
            [
                {"selector": '[data-tid="hangup-main-btn"]'},
                {"selector": '#hangup-button'},
                {"text": "Salir", "exact": True},
                {"text": "Abandonar", "exact": True},
                {"text": "Leave", "exact": True},
            ],
            timeout_ms=8000,
        )

    async def set_mic(self, page, enabled: bool):
        await click_mic_button(
            page,
            enabled,
            # Verificado 2026-10-17: abierto = "Desactivar audio del micrófono".
            when_muted=[
                {"text": "Activar audio del micrófono"},
                {"text": "Activar micrófono"},
                {"text": "Reactivar"},
                {"text": "Unmute"},
            ],
            when_live=[
                {"text": "Desactivar audio del micrófono"},
                {"text": "Silenciar"},
                {"text": "Mute"},
            ],
        )

    async def set_cam(self, page, enabled: bool):
        await set_toggle(
            page,
            enabled,
            # Visibles con la cámara APAGADA:
            when_off=[
                {"text": "Encender la cámara"},
                {"text": "Activar cámara"},
                {"text": "Turn camera on"},
            ],
            # Visibles con la cámara ENCENDIDA:
            when_on=[
                {"text": "Apagar la cámara"},
                {"text": "Desactivar cámara"},
                {"text": "Turn camera off"},
            ],
        )
