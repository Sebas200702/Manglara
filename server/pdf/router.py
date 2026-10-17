"""Endpoints legacy /api/documents/* — ahora PROTEGIDOS por la cookie del
gestor y con la verdad en la BD (documents.active), no en memoria.

El flujo de subida vive en knowledge/router.py (jobs reanudables con
subida directa a Storage): por una función de Vercel no pasa un archivo
grande — el límite del cuerpo de una función es 4.5MB (413 en 18MB).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

import db
import knowledge.auth as auth
from pdf.models import ActivateResponse, DocumentOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/documents", tags=["documents"],
                   dependencies=[Depends(auth.require_admin)])


def _out(doc: dict) -> DocumentOut:
    keys = set(DocumentOut.model_fields)
    return DocumentOut(**{k: doc.get(k) for k in keys})


@router.get("")
async def list_docs():
    docs = await db.list_documents()
    return [_out(d) for d in docs]


@router.get("/{doc_id}")
async def get_doc(doc_id: str):
    doc = await db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return _out(doc)


@router.delete("/{doc_id}")
async def delete_doc(doc_id: str):
    doc = await db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    await db.delete_document(doc_id)
    logger.info("[pdf] deleted %s (%s)", doc_id, doc["name"])
    return {"ok": True}


@router.post("/{doc_id}/archive")
async def archive_doc(doc_id: str):
    doc = await db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    await db.update_document_fields(
        doc_id, {"status": "archived", "active": False,
                 "message": "Archivado desde la API"}
    )
    logger.info("[pdf] archived %s (%s)", doc_id, doc["name"])
    return {"ok": True, "status": "archived"}


@router.post("/{doc_id}/unarchive")
async def unarchive_doc(doc_id: str):
    doc = await db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    await db.update_document_fields(doc_id, {"status": "ready", "message": ""})
    logger.info("[pdf] unarchived %s (%s)", doc_id, doc["name"])
    return {"ok": True, "status": "ready"}


@router.post("/{doc_id}/activate", response_model=ActivateResponse)
async def activate_doc(doc_id: str):
    doc = await db.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc["status"] != "ready":
        raise HTTPException(status_code=400, detail="Document is not ready")
    await db.update_document_fields(doc_id, {"active": True})
    return ActivateResponse(
        document_id=doc_id,
        message=f"Documento '{doc['name']}' activado como fuente de conocimiento",
    )


@router.post("/activate-all")
async def activate_all():
    docs = await db.list_documents()
    ready = [d for d in docs if d["status"] == "ready"]
    for d in ready:
        await db.update_document_fields(d["id"], {"active": True})
    return {"activated": len(ready)}


@router.post("/deactivate-all")
async def deactivate_all():
    docs = await db.list_documents()
    active = [d for d in docs if d.get("active")]
    for d in active:
        await db.update_document_fields(d["id"], {"active": False})
    return {"deactivated": len(active)}
