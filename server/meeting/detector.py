"""Detección y normalización de links de reuniones externas.

Soporta Teams, Zoom y Google Meet. Acepta tanto el link completo como el
ID/código suelto y devuelve la URL canónica para que el bridge la abra.
"""

import re
from typing import Literal

Provider = Literal["teams", "zoom", "meet"]

SUPPORTED_PROVIDERS: tuple[Provider, ...] = ("teams", "zoom", "meet")


class UnsupportedMeetingUrl(ValueError):
    """El input no es un link ni un ID de reunión soportado."""


_DOMAIN_PATTERNS: dict[Provider, re.Pattern] = {
    "teams": re.compile(r"(teams\.microsoft\.com|teams\.live\.com)", re.I),
    "zoom": re.compile(r"(^|[./])zoom\.(us|com)", re.I),
    "meet": re.compile(r"meet\.google\.com", re.I),
}

# Zoom: 9-11 dígitos (con o sin query ?pwd=...). También /my/<alias>.
_ZOOM_ID = re.compile(r"^\d{9,11}$")
_ZOOM_PATH = re.compile(r"^/(j|w|wc|my)/", re.I)

# Meet: código xxx-xxxx-xxx (letras), con o sin guiones/espacios.
_MEET_CODE = re.compile(r"^[a-z]{3}-?[a-z]{4}-?[a-z]{3}$", re.I)
_MEET_PATH = re.compile(r"^/([a-z]{3}-?[a-z]{4}-?[a-z]{3})", re.I)


def _looks_like_url(raw: str) -> bool:
    return "://" in raw or raw.lower().startswith(("www.", "teams.", "zoom.", "meet."))


def detect(raw: str) -> Provider:
    """Detecta el proveedor desde un link o un ID suelto.

    Lanza UnsupportedMeetingUrl si no se reconoce.
    """
    text = (raw or "").strip()
    if not text:
        raise UnsupportedMeetingUrl("Input vacío")

    if _looks_like_url(text):
        lowered = text.lower()
        for provider, pattern in _DOMAIN_PATTERNS.items():
            if pattern.search(lowered):
                return provider
        raise UnsupportedMeetingUrl(f"Dominio no soportado: {text[:80]}")

    # ID suelto: inferir proveedor por formato.
    compact = re.sub(r"[\s-]", "", text).lower()
    if _ZOOM_ID.match(compact):
        return "zoom"
    if _MEET_CODE.match(compact):
        return "meet"
    if _ZOOM_PATH.match("/" + text.strip().lower()):
        return "zoom"
    raise UnsupportedMeetingUrl(
        "No es un link ni un ID de Teams/Zoom/Meet reconocido"
    )


def normalize(provider: Provider, raw: str) -> str:
    """Devuelve la URL canónica para abrir en el navegador.

    - Link completo: se limpia (tracking params fuera, `pwd` de Zoom se conserva).
    - ID suelto: se construye la URL (Zoom y Meet; Teams exige link completo).
    """
    from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

    text = (raw or "").strip()
    if not text:
        raise UnsupportedMeetingUrl("Input vacío")

    if _looks_like_url(text):
        if not text.lower().startswith(("http://", "https://")):
            text = "https://" + text
        if detect(text) != provider:
            raise UnsupportedMeetingUrl(
                f"El link es de otro proveedor (esperado: {provider})"
            )
        parts = urlparse(text)
        query = dict(parse_qsl(parts.query))
        keep = {k: v for k, v in query.items() if k.lower() == "pwd"}
        cleaned = parts._replace(
            scheme="https",
            query=urlencode(keep),
            fragment="",
        )
        return urlunparse(cleaned)

    # ID suelto.
    compact = re.sub(r"[\s-]", "", text).lower()
    if provider == "zoom":
        if _ZOOM_ID.match(compact):
            return f"https://zoom.us/j/{compact}"
        if _ZOOM_PATH.match("/" + compact):
            return f"https://zoom.us/{compact}"
    elif provider == "meet":
        m = _MEET_CODE.match(compact if "-" in text else compact)
        code = compact
        if m and len(code) == 10:
            code = f"{code[:3]}-{code[3:7]}-{code[7:]}"
            return f"https://meet.google.com/{code}"
    elif provider == "teams":
        raise UnsupportedMeetingUrl("Teams requiere el link completo, no solo el ID")
    raise UnsupportedMeetingUrl(f"ID no válido para {provider}")


_URL_IN_TEXT = re.compile(r"https?://([^/\s\"'<>]+)[^\s\"'<>]*", re.I)


def redact_urls(text: str) -> str:
    """Reemplaza URLs por solo su dominio (para logs y mensajes de error).

    Los links de reunión llevan IDs y contraseñas (`pwd`); las excepciones de
    Playwright los incluyen completos ("navigating to https://...").
    """
    return _URL_IN_TEXT.sub(lambda m: f"https://{m.group(1)}/…", text or "")


def detect_and_normalize(raw: str) -> tuple[Provider, str]:
    """Atajo: detecta el proveedor y devuelve (provider, url_canónica)."""
    provider = detect(raw)
    return provider, normalize(provider, raw)
