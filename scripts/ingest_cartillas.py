"""
One-shot script to ingest all cartillas (.docx) into Supabase + Gemini.
Usage:
    python scripts/ingest_cartillas.py
Requires .env with:
    GEMINI_API_KEY
    SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_DB_URL / SUPABASE_STORAGE_BUCKET
"""

import asyncio
import logging
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("ingest")

CARTILLAS_DIR = Path(__file__).resolve().parent.parent / "cartillas"


async def main():
    from config import (
        GEMINI_API_KEY,
        SUPABASE_URL,
        SUPABASE_SERVICE_KEY,
        SUPABASE_STORAGE_BUCKET,
    )
    from google import genai as genai_module
    from storage import StorageClient
    from pdf.ingest import extract_text_docx, chunk_pages, embed_chunks
    from db import insert_document, insert_chunks

    storage = StorageClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_STORAGE_BUCKET)
    genai_client = genai_module.Client(api_key=GEMINI_API_KEY)

    docx_files = sorted(CARTILLAS_DIR.glob("*.docx"))
    if not docx_files:
        logger.warning("No .docx files found in %s", CARTILLAS_DIR)
        return

    logger.info("Found %d cartillas to ingest", len(docx_files))
    results = []

    for fp in docx_files:
        logger.info("Processing %s ...", fp.name)
        try:
            data = fp.read_bytes()

            pages = extract_text_docx(str(fp))
            if not pages:
                logger.warning("  no text extracted, skipping")
                continue

            chunks = chunk_pages(pages)
            embed_chunks(chunks)

            file_uri = None
            try:
                gf = genai_client.files.upload(file=str(fp))
                file_uri = gf.uri
                logger.info("  uploaded to Gemini Files API")
            except Exception as e:
                logger.warning("  Gemini upload failed (non-critical): %s", e)

            storage_path = f"{uuid.uuid4()}/{fp.name}"
            await storage.upload(storage_path, data)
            logger.info("  uploaded to Supabase Storage")

            doc_id = await insert_document(
                name=fp.name,
                storage_path=storage_path,
                page_count=len(pages),
                file_uri=file_uri,
            )

            db_chunks = [
                {
                    "document_id": doc_id,
                    "content": c["content"],
                    "page_num": c["page_num"],
                    "chunk_index": c["chunk_index"],
                    "embedding": c["embedding"],
                }
                for c in chunks
            ]
            await insert_chunks(db_chunks)

            results.append({
                "filename": fp.name,
                "document_id": doc_id,
                "chunks": len(chunks),
                "pages": len(pages),
                "status": "ok",
            })
            logger.info("  ✓ ingested (%d pages, %d chunks)", len(pages), len(chunks))

        except Exception as e:
            logger.error("  ✗ failed: %s", e)
            results.append({"filename": fp.name, "status": "error", "error": str(e)})

    print("\n" + "=" * 60)
    print("INGESTION SUMMARY")
    print("=" * 60)
    ok = [r for r in results if r["status"] == "ok"]
    err = [r for r in results if r["status"] != "ok"]
    for r in ok:
        print(f"  [OK] {r['filename']} -> {r['document_id']} ({r['pages']} pag, {r['chunks']} chunks)")
    for r in err:
        print(f"  [FAIL] {r['filename']} -> {r['error']}")
    print(f"\n{len(ok)} ingested, {len(err)} failed")

    if ok:
        print("\nPara activar un documento en la llamada:")
        for r in ok:
            print(f'  curl -X POST http://localhost:3000/api/documents/{r["document_id"]}/activate')


if __name__ == "__main__":
    asyncio.run(main())
