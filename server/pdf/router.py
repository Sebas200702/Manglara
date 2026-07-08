import logging
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException

from google import genai as genai_module

from config import (
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    SUPABASE_STORAGE_BUCKET,
    GEMINI_API_KEY,
)
from db import get_document, list_documents, delete_document
from storage import StorageClient
from pdf.ingest import ingest_document
from pdf.models import DocumentOut, IngestResponse, ActivateResponse

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".pdf", ".docx"}

router = APIRouter(prefix="/api/documents", tags=["documents"])

_active_documents: list[str] = []


def get_active_documents() -> list[str]:
    return _active_documents


def set_active_documents(doc_ids: list[str]):
    global _active_documents
    _active_documents = doc_ids


@router.get("")
async def list_docs():
    docs = await list_documents()
    return [DocumentOut(**d) for d in docs]


@router.get("/{doc_id}")
async def get_doc(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    return DocumentOut(**doc)


@router.delete("/{doc_id}")
async def delete_doc(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    await delete_document(doc_id)
    if doc_id in _active_documents:
        _active_documents.remove(doc_id)
    return {"ok": True}


@router.post("/upload", response_model=IngestResponse)
async def upload_document(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "File has no filename")

    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Only {', '.join(ALLOWED_EXTENSIONS)} files are allowed")

    data = await file.read()
    if len(data) == 0:
        raise HTTPException(400, "Empty file")
    if len(data) > 50 * 1024 * 1024:
        raise HTTPException(400, "File exceeds 50MB limit")

    storage = StorageClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_STORAGE_BUCKET)
    genai_client = genai_module.Client(api_key=GEMINI_API_KEY)

    result = await ingest_document(data, file.filename, storage, genai_client)

    if result["status"] == "error":
        raise HTTPException(500, result["message"])

    return IngestResponse(
        document_id=result["document_id"],
        status=result["status"],
        chunks_count=result["chunks_count"],
        pages=result["pages"],
    )


@router.post("/{doc_id}/activate", response_model=ActivateResponse)
async def activate_doc(doc_id: str):
    doc = await get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    if doc["status"] != "ready":
        raise HTTPException(400, "Document is not ready")
    if doc_id not in _active_documents:
        _active_documents.append(doc_id)
    logger.info("[pdf] activated document %s (%s)", doc_id, doc["name"])
    return ActivateResponse(
        document_id=doc_id,
        message=f"Documento '{doc['name']}' activado como fuente de conocimiento",
    )


@router.post("/activate-all")
async def activate_all():
    docs = await list_documents()
    ready = [d["id"] for d in docs if d["status"] == "ready"]
    if not ready:
        raise HTTPException(400, "No documents available to activate")
    set_active_documents(ready)
    logger.info("[pdf] activated %d documents", len(ready))
    return {
        "activated": len(ready),
        "document_ids": ready,
        "message": f"{len(ready)} documentos activados como fuente de conocimiento",
    }


@router.post("/deactivate-all")
async def deactivate_all():
    set_active_documents([])
    logger.info("[pdf] all documents deactivated")
    return {"message": "Todos los documentos desactivados"}
