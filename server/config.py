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

# Live Meeting con Manglara: bot que se une a reuniones externas
# (Teams/Zoom/Meet). Todo opcional, con defaults sanos.
MEETING_BOT_NAME = os.getenv("MEETING_BOT_NAME", "Manglara")
MEETING_HEADLESS = os.getenv("MEETING_HEADLESS", "true").lower() in (
    "1",
    "true",
    "yes",
)
# Directorio de perfil persistente de Chromium para cuentas pre-logueadas
# (necesario para Meet). Vacío = perfil efímero (invitado).
MEETING_CHROME_PROFILE_DIR = os.getenv("MEETING_CHROME_PROFILE_DIR", "")
MEETING_MAX_DURATION_MIN = int(os.getenv("MEETING_MAX_DURATION_MIN", "180"))
MEETING_AVATAR_URL = os.getenv("MEETING_AVATAR_URL", "/meeting/avatar")
