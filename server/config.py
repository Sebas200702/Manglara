import os
from dotenv import load_dotenv

env_paths = [
    os.path.join(os.path.dirname(__file__), "..", ".env"),
    os.path.join(os.getcwd(), ".env"),
    os.path.join(os.getcwd(), "..", ".env"),
]
for p in env_paths:
    if os.path.exists(p):
        load_dotenv(p)
        break


def _require(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


GEMINI_API_KEY = _require("GEMINI_API_KEY")
GEMINI_LIVE_MODEL = os.getenv(
    "GEMINI_LIVE_MODEL", "models/gemini-3.1-flash-live-preview"
)
GEMINI_DIGEST_MODEL = os.getenv("GEMINI_DIGEST_MODEL", "models/gemini-3.5-flash")
GEMINI_VOICE_NAME = os.getenv("GEMINI_VOICE_NAME", "Zephyr")
PORT = int(os.getenv("PORT", "8000"))

# Orígenes extra del frontend con permiso CORS (coma-separados), p. ej. la web
# desplegada: la pantalla de reuniones llama a la API REST del backend.
CORS_ALLOW_ORIGINS = [
    o.strip().rstrip("/")
    for o in os.getenv("CORS_ALLOW_ORIGINS", "").split(",")
    if o.strip()
]

def _csv(name: str) -> list[str]:
    return [o.strip().rstrip("/") for o in os.getenv(name, "").split(",") if o.strip()]


def _flag(name: str, default: str) -> bool:
    return os.getenv(name, default).lower() in ("1", "true", "yes")


# Voz pública (/ws/voice). Cada sesión abre una sesión de Gemini Live y gasta
# cuota: estos topes la protegen. 0 / vacío = sin límite (comportamiento previo).
# Ojo con el tope por IP: en un evento muchas personas comparten la IP del wifi.
VOICE_MAX_SESSIONS = int(os.getenv("VOICE_MAX_SESSIONS", "0"))
VOICE_MAX_SESSIONS_PER_IP = int(os.getenv("VOICE_MAX_SESSIONS_PER_IP", "0"))
# Orígenes del navegador que pueden abrir la voz (coma-separados). Vacío = todos.
VOICE_ALLOWED_ORIGINS = _csv("VOICE_ALLOWED_ORIGINS")
# Sesiones nuevas por minuto: cada conexión manda el system prompt completo
# (~18k tokens) y una ráfaga agota los tokens por minuto de Gemini Live.
VOICE_MAX_NEW_SESSIONS_PER_MIN = int(os.getenv("VOICE_MAX_NEW_SESSIONS_PER_MIN", "0"))
# Cierra la sesión si la persona no habla en este tiempo (0 = nunca): una
# pestaña olvidada sigue gastando audio y video.
VOICE_IDLE_TIMEOUT_S = float(os.getenv("VOICE_IDLE_TIMEOUT_S", "90"))
# Duración máxima de una sesión de voz (0 = sin límite).
VOICE_MAX_SESSION_MIN = float(os.getenv("VOICE_MAX_SESSION_MIN", "0"))
# Conocimiento precargado en el system prompt de cada sesión (caracteres).
# Menos = conexión más barata; la recuperación (RAG) sigue cubriendo el resto.
VOICE_PRELOAD_CHARS = int(os.getenv("VOICE_PRELOAD_CHARS", "60000"))
# Resolución con la que Gemini tokeniza los frames de la cámara. LOW cuesta
# ~4 veces menos por frame. Vacío = la del modelo.
GEMINI_MEDIA_RESOLUTION = os.getenv("GEMINI_MEDIA_RESOLUTION", "MEDIA_RESOLUTION_LOW")
# Registrar transcripciones de la voz pública en los logs (datos personales).
LOG_TRANSCRIPTS = _flag("LOG_TRANSCRIPTS", "true")
# API del bot de reuniones (/meetings, /ws/meetings). No tiene autenticación:
# en la instancia pública conviene apagarla si no se usa.
MEETINGS_ENABLED = _flag("MEETINGS_ENABLED", "true")

SUPABASE_URL = _require("SUPABASE_URL")
SUPABASE_SERVICE_KEY = _require("SUPABASE_SERVICE_KEY")
SUPABASE_STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "documents")

# Live Meeting con Manglara: bot que se une a reuniones externas
# (Teams/Zoom/Meet). Todo opcional, con defaults sanos.
MEETING_BOT_NAME = os.getenv("MEETING_BOT_NAME", "Manglara")
MEETING_HEADLESS = os.getenv("MEETING_HEADLESS", "true").lower() in (
    "1",
    "true",
    "yes",
)
MEETING_CHROMIUM_EXECUTABLE = os.getenv("MEETING_CHROMIUM_EXECUTABLE", "")
# Directorio de perfil persistente de Chromium para cuentas pre-logueadas
# (necesario para Meet). Vacío = perfil efímero (invitado).
MEETING_CHROME_PROFILE_DIR = os.getenv("MEETING_CHROME_PROFILE_DIR", "")
MEETING_MAX_DURATION_MIN = int(os.getenv("MEETING_MAX_DURATION_MIN", "180"))
# Sale sola si es la única participante este tiempo (0 = nunca).
MEETING_ALONE_TIMEOUT_MIN = float(os.getenv("MEETING_ALONE_TIMEOUT_MIN", "10"))
# Página del avatar que el bot usa como cámara (ruta de la web app). Una ruta
# relativa se resuelve contra MEETING_WEB_URL; una URL absoluta se usa tal cual.
MEETING_AVATAR_URL = os.getenv("MEETING_AVATAR_URL", "/meeting/avatar")
# Origen público de la web app (Vite en dev). Vacío desactiva el avatar y la
# cámara queda con el logo animado.
MEETING_WEB_URL = os.getenv("MEETING_WEB_URL", "http://localhost:5173").rstrip("/")
# Silencio (ms) tras el que Gemini da por terminado el turno de un participante,
# con fin de voz en sensibilidad alta. Medido: 500 ms responde ~0.4 s antes que
# el VAD por defecto; menos no gana nada y corta a quien hace pausas. 0 = VAD
# por defecto de Gemini.
MEETING_VAD_SILENCE_MS = int(os.getenv("MEETING_VAD_SILENCE_MS", "500"))

# --- Panel de conocimiento (Fase 1) --------------------------------
# Acceso: una sola clave compartida con los gestores.
# ADMIN_PASSWORD_HASH tiene prioridad sobre ADMIN_PASSWORD:
#   python scripts/hash_password.py          # genera y copia al .env
# SESSION_SECRET firma la cookie; si falta se deriva de ADMIN_PASSWORD
# para no exigir una variable más (así la cookie sobrevive un restart
# en serverless, que rota instancias sin aviso).
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
ADMIN_PASSWORD_HASH = os.getenv("ADMIN_PASSWORD_HASH")
SESSION_SECRET = os.getenv("SESSION_SECRET")
SESSION_TTL_HOURS = int(os.getenv("SESSION_TTL_HOURS", "12"))
LOGIN_ATTEMPTS_PER_MINUTE = int(os.getenv("LOGIN_ATTEMPTS_PER_MINUTE", "5"))

# Orígenes del panel que pueden llamar a la API con cookie. En Vercel
# la web proxía /api/* al server (mismo origen), y en desarrollo el
# proxy de Vite hace lo mismo, así que basta con aceptar el origen de
# la propia web; se lista por si alguien salta el proxy.
KNOWLEDGE_ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("KNOWLEDGE_ALLOWED_ORIGINS", "").split(",")
    if o.strip()
]
