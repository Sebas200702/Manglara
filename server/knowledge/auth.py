"""Acceso del gestor al panel de conocimiento.

Modelo elegido por decisión del proyecto: UNA sola clave compartida, por eso
no hay tabla de usuarios. La clave vive en ADMIN_PASSWORD_HASH (recomendado,
lo genera scripts/hash_password.py con scrypt) o directamente en
ADMIN_PASSWORD.

La sesión es una cookie firmada con HMAC-SHA256: sin tabla de sesiones y
sin perder la sesión cuando serverless rota instancia (pasa en Vercel con
cada arranque frío) porque la verificación es puramente local al token.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from collections import deque

from fastapi import HTTPException, Request

import config

logger = logging.getLogger(__name__)

COOKIE_NAME = "manglara_knowledge"
SESSION_TTL_SECONDS = config.SESSION_TTL_HOURS * 3600
_RATE_WINDOW_SECONDS = 60

# Debe coincidir con scripts/hash_password.py: el límite por defecto de
# OpenSSL (32 MiB) es menor que la memoria real que pide N=2^16.
SCRYPT_MAXMEM = 128 * 1024 * 1024

# ip -> timestamps de los últimos intentos de login (por proceso). En
# serverless no es global entre instancias, pero corta el martilleo básico.
_login_attempts: dict[str, deque] = {}

_cached_key: tuple[str, bytes] | None = None


def _key() -> bytes:
    """Clave HMAC de la cookie. Preferencia explícita (SESSION_SECRET);
    si no hay, se deriva de la clave del gestor o de su hash — importante
    cuando en el entorno SOLO existe ADMIN_PASSWORD_HASH y no la clave en
    claro: con una constante vacía cualquiera forjaría la cookie."""
    global _cached_key
    if _cached_key is None or _cached_key[0] != _secret_source():
        _cached_key = (_secret_source(), hashlib.sha256(_secret_source().encode()).digest())
    return _cached_key[1]


def _secret_source() -> str:
    if config.SESSION_SECRET:
        return config.SESSION_SECRET
    if config.ADMIN_PASSWORD:
        return config.ADMIN_PASSWORD
    if config.ADMIN_PASSWORD_HASH:
        return config.ADMIN_PASSWORD_HASH
    if os.getenv("SKIP_ADMIN_WARNING") != "1":
        logger.warning(
            "[auth] sin ADMIN_PASSWORD/HASH ni SESSION_SECRET: la sesión se "
            "firma con una constante (solo aceptable en desarrollo)"
        )
    return "manglara-dev-insecure-session"


def check_password(candidate: str) -> bool:
    """scrypt:<N>:<r>:<p>:<salt_hex>:<hash_hex>, o texto plano del env."""
    if config.ADMIN_PASSWORD_HASH:
        parts = config.ADMIN_PASSWORD_HASH.split(":")
        if parts[0] != "scrypt" or len(parts) != 6:
            logger.error("[auth] ADMIN_PASSWORD_HASH con formato inválido")
            return False
        try:
            n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
            expected = bytes.fromhex(parts[5])
            candidate_hash = hashlib.scrypt(
                (candidate or "").encode(),
                salt=bytes.fromhex(parts[4]), n=n, r=r, p=p,
                dklen=len(expected), maxmem=SCRYPT_MAXMEM,
            )
        except (ValueError, TypeError):
            logger.error("[auth] ADMIN_PASSWORD_HASH no se puede parsear")
            return False
        return hmac.compare_digest(candidate_hash, expected)
    # Comparación en tiempo constante: se compara un HMAC de lo recibido
    # contra un HMAC del valor esperado (nunca un `==` sobre cadenas).
    expected = hmac.new(_key(), (config.ADMIN_PASSWORD or "").encode(), hashlib.sha256).digest()
    given = hmac.new(_key(), (candidate or "").encode(), hashlib.sha256).digest()
    return hmac.compare_digest(expected, given)


# --- cookie --------------------------------------------------------------
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64url(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def make_session_token(now: float | None = None) -> str:
    ts = int(now if now is not None else time.time())
    payload = {"iat": ts, "exp": ts + SESSION_TTL_SECONDS, "nonce": secrets.token_hex(8)}
    body = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{hmac.new(_key(), body.encode(), hashlib.sha256).hexdigest()}"


def verify_session_token(token: str) -> bool:
    if not token or "." not in token:
        return False
    body, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(
        hmac.new(_key(), body.encode(), hashlib.sha256).hexdigest(), sig
    ):
        return False
    try:
        payload = json.loads(_unb64url(body))
    except (ValueError, json.JSONDecodeError):
        return False
    return payload.get("exp", 0) > time.time()


def cookie_params(request: Request) -> dict:
    """Parámetros para response.set_cookie en el login/logout.

    El panel siempre habla a la API por el propio origen de la web (Vercel
    reescribe /api/* y en dev lo hace el proxy de Vite), así que la cookie
    es first-party: SameSite=Lax basta y no renunció nada a la seguridad.
    En localhost http no forzamos Secure para que el navegador la mande.
    """
    host = request.headers.get("host", "")
    localhost = host.startswith("localhost") or host.startswith("127.0.0.1")
    return {
        "key": COOKIE_NAME,
        "httponly": True,
        "secure": not localhost,
        "samesite": "lax",
        "max_age": SESSION_TTL_SECONDS,
        "path": "/",
    }


# --- dependencia de FastAPI ---------------------------------------------
def require_admin(request: Request) -> None:
    """401 si la cookie no es válida. Úsese como dependencia en el router."""
    token = request.cookies.get(COOKIE_NAME)
    if not verify_session_token(token):
        raise HTTPException(status_code=401, detail="No autenticado")


# --- rate limit del login ------------------------------------------------
def login_rate_limited(ip: str) -> bool:
    now = time.time()
    q = _login_attempts.setdefault(ip, deque())
    while q and q[0] < now - _RATE_WINDOW_SECONDS:
        q.popleft()
    if len(q) >= config.LOGIN_ATTEMPTS_PER_MINUTE:
        return True
    q.append(now)
    return False
