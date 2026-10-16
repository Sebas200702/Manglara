"""Modelos de sesión del bot de reuniones. Solo datos, sin lógica."""

import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

from .detector import Provider

BridgeState = Literal[
    "idle",  # creada, browser aún no lanzado
    "launching",  # Chromium arrancando
    "joining",  # navegando + flujo de join del proveedor
    "lobby",  # en sala de espera, pendiente de admisión
    "in_meeting",  # dentro de la reunión (dormida o activa)
    "leaving",  # saliendo, limpiando recursos
    "closed",  # terminada (salida limpia)
    "error",  # fallo (ver error)
]

BrainState = Literal[
    "off",  # Gemini Live apagado (dormida)
    "starting",  # conectando a Gemini
    "active",  # escucha y habla
    "stopping",  # cerrando sesión Gemini
]


@dataclass
class MediaState:
    mic_enabled: bool = False  # voz del bot hacia la reunión
    cam_enabled: bool = True  # video del bot hacia la reunión


@dataclass
class MeetingSession:
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    provider: Provider = "teams"
    url: str = ""
    name: str = "Manglara"
    bridge: BridgeState = "idle"
    brain: BrainState = "off"
    media: MediaState = field(default_factory=MediaState)
    error: str | None = None
    created_at: float = field(default_factory=time.time)

    def public_state(self) -> dict:
        """Lo que la UI necesita. Sin URLs completas (privacidad)."""
        return {
            "id": self.id,
            "provider": self.provider,
            "name": self.name,
            "bridge": self.bridge,
            "brain": self.brain,
            "mic_enabled": self.media.mic_enabled,
            "cam_enabled": self.media.cam_enabled,
            "error": self.error,
        }
