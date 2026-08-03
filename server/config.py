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
