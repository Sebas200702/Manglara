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
PORT = int(os.getenv("PORT", "3000"))

SUPABASE_URL = _require("SUPABASE_URL")
SUPABASE_SERVICE_KEY = _require("SUPABASE_SERVICE_KEY")
SUPABASE_STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "documents")

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
