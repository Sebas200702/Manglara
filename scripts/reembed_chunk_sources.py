"""Re-vectoriza los chunks existentes con el modelo de embeddings de Gemini.

Obligatoria una vez tras migrar de fastembed a Gemini: los vectores de dos
modelos distintos viven en espacios incompatibles y el RAG dejaría de
encontrar nada. Se corre UNA vez (o si se cambia GEMINI_EMBEDDING_MODEL y
se decide re-alinear todo de nuevo).

Uso:
    python scripts/reembed_chunk_sources.py           # simnulación
    python scripts/reembed_chunk_sources.py --apply   # escribe embeddings
    python scripts/reembed_chunk_sources.py --doc <id> --apply  # solo uno

UPSERT con merge-duplicates en lotes de 32: conserva id/page/chunk_index.
"""

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("reembed")


async def main() -> None:
    import db
    from knowledge.embedding import EMBEDDING_MODEL, get_embedding_client, reembed_document

    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="escribir en Supabase")
    ap.add_argument("--doc", help="restringir a un document_id")
    args = ap.parse_args()

    documents = await db.list_documents()
    targets = [d for d in documents if args.doc in (None, d["id"])]
    if not targets:
        print("No hay documentos para re-vectorizar")
        return

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{url}/rest/v1/chunks",
            params={"select": "id,document_id", "limit": 100000},
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        counts: dict[str, int] = {}
        for row in resp.json():
            counts[row["document_id"]] = counts.get(row["document_id"], 0) + 1

    print(f"Modelo destino: {EMBEDDING_MODEL}")
    for d in targets:
        n = counts.get(d["id"], 0)
        print(f"  [{d['status']:>8}] {d['name']:<50} chunks={n}")
    if not args.apply:
        print("\n(simulación: no se escribió nada. Repite con --apply)")
        return

    client = get_embedding_client()
    for d in targets:
        try:
            total = await reembed_document(d["id"])
            log.info("OK  %s — %d chunks re-vectorizados", d["name"], total)
        except Exception as e:
            log.error("FALLO %s — %s", d["name"], e)
    log.info("terminado")


if __name__ == "__main__":
    asyncio.run(main())
