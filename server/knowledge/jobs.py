"""Pipeline de ingesta por etapas, REANUDABLE.

Cada etapa persiste su avance ANTES de la siguiente; re-invocar /run
continúa desde donde quedó. Si el run se acerca al límite de tiempo de
Vercel (300s), corta en `SOFT_TIMEOUT_S` devolviendo `needs_continue` y
el navegador vuelve a llamar /run: ningún tamaño de documento rompe.

Estados del job (knowledge_jobs.status):
  signed → extracting → embedding → digesting → done │ error

La extracción y el chunking son deterministas (`extract_text_*` sobre el
MISMO archivo ya subido a Storage); un re-run recalcula los chunks al
vuelo y salta los lotes ya insertados. La verdad del progreso es la
tabla `chunks` (máximo chunk_index) + knowledge_jobs.chunks_done.
"""

import asyncio
import logging
import tempfile
import time
from pathlib import Path

import httpx

import db
from knowledge.embedding import EMBED_BATCH, embed_texts, ingest_batch_with_embeddings
from pdf.digest import generate_digest
from pdf.ingest import chunk_pages, extract_text_docx, extract_text_pdf
from storage import StorageClient

logger = logging.getLogger(__name__)

SOFT_TIMEOUT_S = 240  # margen sobre el máximo de 300s de Vercel


def _snapshot(job: dict | None) -> dict:
    if not job:
        return {"status": "error", "error": "job desaparecido"}
    return {
        "status": job["status"],
        "stage": job.get("stage"),
        "progress": job.get("progress", 0),
        "chunks_total": job.get("chunks_total"),
        "chunks_done": job.get("chunks_done"),
        "document_id": job.get("document_id"),
        "error": job.get("error"),
    }


def _extract_sync(data: bytes, filename: str) -> tuple[list[dict], int]:
    ext = Path(filename).suffix.lower()
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    tmp.write(data)
    tmp.close()
    try:
        extract = extract_text_pdf if ext == ".pdf" else extract_text_docx
        pages = extract(tmp.name)
    finally:
        Path(tmp.name).unlink(missing_ok=True)
    if not pages:
        raise ValueError("No se extrajo texto del documento (¿PDF escaneado?)")
    chunks = chunk_pages(pages)
    if not chunks:
        raise ValueError("El documento no produjo chunks útiles")
    return chunks, len(pages)


def _extract_chunks(storage: StorageClient, job: dict) -> tuple[list[dict], int]:
    """Sync helper para asyncio.to_thread: baja (I/O en el hilo) y extrae."""
    data = storage.download_sync(job["storage_path"])
    return _extract_sync(data, job["filename"])


async def _last_chunk_index(document_id: str | None) -> int:
    if not document_id:
        return 0
    async with httpx.AsyncClient() as http:
        resp = await http.get(
            f"{db.BASE}/chunks",
            params={
                "document_id": f"eq.{document_id}",
                "order": "chunk_index.desc",
                "limit": 1,
            },
            headers=db.HEADERS,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0]["chunk_index"] if rows else 0


async def _reset_replace_row(job: dict, storage: StorageClient) -> None:
    """Antes de tocar la fila del documento en modo 'replace': snapshot del
    estado previo a document_versions, limpia chunks y origen viejo."""
    old = await db.get_document(job["document_id"])
    if not old:
        raise ValueError(f"El documento {job['document_id']} ya no existe")
    await db.insert_document_version({
        "document_id": old["id"],
        "version": int(old.get("version", 1)),
        "name": old["name"],
        "digest": old.get("digest"),
        "page_count": old.get("page_count"),
        "storage_path": old.get("storage_path"),
        "file_uri": old.get("file_uri"),
        "note": f"Reemplazado por {job['filename']}",
        "created_by": job.get("created_by") or "gestor",
    })
    try:
        if old.get("storage_path"):
            await storage.delete(old["storage_path"])
    except Exception as exc:  # ya borrado/renombre: no detiene el re-run
        logger.warning("[job %s] archivo anterior no se pudo borrar: %s", job["id"], exc)
    await db.delete_chunks_by_document(old["id"])
    await db.update_document_fields(old["id"], {
        "name": job["filename"],
        "storage_path": job["storage_path"],
        "page_count": None,
        "file_uri": None,
        "version": int(old.get("version", 1)) + 1,
        "origin": "upload",
        "status": "processing",
        "active": False,
        "message": "procesando reemplazo",
    })
    await db.insert_event(
        "replace", document_id=old["id"],
        created_by=job.get("created_by") or "gestor",
        detail={"before": old["name"], "after": job["filename"], "job_id": job["id"]},
    )


async def run_job(job_id: str, storage: StorageClient, genai_client) -> dict:
    job = await db.get_knowledge_job(job_id)
    if not job:
        raise KeyError(job_id)
    if job["status"] in ("done", "error"):
        return _snapshot(job)

    started = time.monotonic()
    created_by = job.get("created_by") or "gestor"
    is_first_run = job["status"] == "signed"
    document_id = job.get("document_id")

    try:
        if is_first_run:
            await db.update_knowledge_job(job_id, {
                "status": "extracting", "stage": "extracting", "progress": 8,
            })
            chunks, page_count = await asyncio.to_thread(_extract_chunks, storage, job)
            chunks_total = len(chunks)

            if job["mode"] == "replace":
                if not job.get("document_id"):
                    raise ValueError("job 'replace' sin document_id")
                await _reset_replace_row(job, storage)
                document_id = job["document_id"]
            else:
                created = await db.insert_document(
                    name=job["filename"], storage_path=job["storage_path"],
                    page_count=page_count, file_uri=None, status="processing",
                )
                document_id = created["id"]
                await db.insert_event(
                    "upload", document_id=document_id, created_by=created_by,
                    detail={"filename": job["filename"], "job_id": job_id,
                            "chunks": chunks_total},
                )

            await db.update_knowledge_job(job_id, {
                "status": "embedding", "stage": "embedding",
                "chunks_total": chunks_total, "chunks_done": 0,
                "document_id": document_id, "progress": 12,
            })
            logger.info("[job %s] %d chunks listos para vectorizar", job_id, chunks_total)
        else:
            chunks, page_count = await asyncio.to_thread(_extract_chunks, storage, job)
            chunks_total = len(chunks)
            if not document_id:
                raise ValueError("re-run sin document_id en el job")

        # 2) embedding por lotes — reanuda desde lo ya insertado.
        # El chunk_index insertado es la verdad: usamos max(chunks_done del
        # job, último chunk_index en BD) como punto de partida.
        start_index = max(
            int(job.get("chunks_done") or 0), await _last_chunk_index(document_id)
        )
        chunks_total = max(chunks_total, int(job.get("chunks_total") or chunks_total))

        while start_index < chunks_total:
            if time.monotonic() - started > SOFT_TIMEOUT_S:
                logger.info("[job %s] presupuesto de tiempo agotado; devolviendo needs_continue", job_id)
                await db.update_knowledge_job(job_id, {
                    "stage": "embedding",
                    "chunks_done": start_index, "chunks_total": chunks_total,
                    "document_id": document_id,
                    "progress": 12 + int(58 * start_index / max(chunks_total, 1)),
                })
                return {"status": "needs_continue", "job": job_id,
                        "stage": "embedding", "chunks_done": start_index,
                        "chunks_total": chunks_total}
            batch = chunks[start_index:start_index + EMBED_BATCH]
            embeddings = await embed_texts([c["content"] for c in batch])
            await ingest_batch_with_embeddings(document_id, start_index, batch, embeddings)
            start_index += len(batch)
            await db.update_knowledge_job(job_id, {
                "stage": "embedding",
                "chunks_done": start_index, "chunks_total": chunks_total,
                "document_id": document_id,
                "progress": 12 + int(58 * start_index / max(chunks_total, 1)),
            })

        # 3) digest (alimenta el preload del system prompt; el resto RAG)
        await db.update_knowledge_job(job_id, {"stage": "digesting", "progress": 88})
        doc = await db.get_document(document_id)
        row_chunks = await db.get_document_chunks(document_id)
        full_text = "\n\n".join(c["content"] for c in row_chunks)
        digest = await generate_digest(genai_client, doc["name"], full_text)
        if digest:
            await db.update_document_digest(document_id, digest)
            logger.info("[job %s] digest de %d chars", job_id, len(digest))

        # 4) listo. La ACTIVACIÓN la decide el gestor en el panel: aquí solo
        #    se marca ready. En el reemplace se conserva el estado previo.
        final = {"status": "ready", "message": "", "page_count": page_count}
        if job["mode"] == "new":
            final["active"] = False
        await db.update_document_fields(document_id, final)
        await db.insert_event(
            "ingest_done" if job["mode"] == "new" else "replace",
            document_id=document_id, created_by=created_by,
            detail={
                "filename": job["filename"], "chunks": chunks_total,
                "pages": page_count, "digest_chars": len(digest or ""),
                "job_id": job_id,
            },
        )
        await db.update_knowledge_job(job_id, {
            "status": "done", "stage": "done", "progress": 100, "error": None,
            "document_id": document_id, "chunks_total": chunks_total,
            "chunks_done": chunks_total,
        })
        return _snapshot(await db.get_knowledge_job(job_id))

    except Exception as exc:
        logger.exception("[job %s] falló", job_id)
        await db.update_knowledge_job(job_id, {"status": "error", "error": str(exc)[:500]})
        await db.insert_event(
            "error", document_id=document_id, created_by=created_by,
            detail={"filename": job["filename"], "error": str(exc)[:300],
                    "job_id": job_id},
        )
        return _snapshot(await db.get_knowledge_job(job_id))
