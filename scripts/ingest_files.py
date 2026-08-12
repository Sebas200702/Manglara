"""Ingest specific files into the context system (Supabase + Gemini).

Unlike ingest_cartillas.py (which ingests every .docx in cartillas/), this
targets only the paths you pass, so you can add or re-ingest a single document
without duplicating the rest.

Usage:
    python scripts/ingest_files.py <path1> [<path2> ...]

Requires the same .env as the server (GEMINI_API_KEY, SUPABASE_*).
"""

import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("ingest_files")


async def main(paths: list[str]):
    from config import (
        GEMINI_API_KEY,
        SUPABASE_URL,
        SUPABASE_SERVICE_KEY,
        SUPABASE_STORAGE_BUCKET,
    )
    from google import genai as genai_module
    from storage import StorageClient
    from pdf.ingest import ingest_document

    storage = StorageClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_STORAGE_BUCKET)
    genai_client = genai_module.Client(api_key=GEMINI_API_KEY)

    for p in paths:
        fp = Path(p)
        if not fp.exists():
            logger.error("skipping missing file: %s", fp)
            continue
        logger.info("ingesting %s ...", fp.name)
        result = await ingest_document(fp.read_bytes(), fp.name, storage, genai_client)
        logger.info("  -> %s", result)
        print(result)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    asyncio.run(main(sys.argv[1:]))
