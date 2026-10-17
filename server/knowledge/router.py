"""API de gestión de conocimiento para el panel (Fase 1: cartillas).

Tres routers:
  auth      → /api/auth/*        login/logout/me (una clave, cookie firmada)
  knowledge → /api/knowledge/*   fuentes, jobs, preview, budget, export
  (pdf)     → /api/documents/*   endpoints legacy, protegidos en main.py

Todo require cookie de sesión salvo login y /health.
"""

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

import config
import db
import knowledge.auth as auth
from pdf.digest import MAX_KNOWLEDGE_CHARS
from storage import StorageClient

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".pdf", ".docx"}
MAX_FILE_BYTES = 50 * 1024 * 1024

auth_router = APIRouter(prefix="/api/auth", tags=["auth"])
router = APIRouter(prefix="/api/knowledge", tags=["knowledge"],
                   dependencies=[Depends(auth.require_admin)])

_session_storage: StorageClient | None = None


def storage() -> StorageClient:
    global _session_storage
    if _session_storage is None:
        _session_storage = StorageClient(
            config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, config.SUPABASE_STORAGE_BUCKET
        )
    return _session_storage


def _client_ip(request: Request) -> str:
    return (request.headers.get("x-forwarded-for") or "").split(",")[0].strip() \
        or (request.client.host if request.client else "anon")


# --- auth ---------------------------------------------------------------

class LoginIn(BaseModel):
    password: str


@auth_router.post("/login")
async def login(request: Request, response: Response, body: LoginIn):
    ip = _client_ip(request)
    if auth.login_rate_limited(ip):
        raise HTTPException(429, "Demasiados intentos; espera un minuto")
    if not auth.check_password(body.password):
        logger.warning("[auth] intento fallido desde %s", ip)
        raise HTTPException(401, "La clave no es correcta")
    token = auth.make_session_token()
    params = auth.cookie_params(request)
    response.set_cookie(value=token, **params)
    await db.insert_event("login", detail={"ip": ip})
    return {"ok": True}


@auth_router.post("/logout")
async def logout(request: Request, response: Response):
    params = auth.cookie_params(request)
    response.delete_cookie(params["key"], path="/", httponly=True, samesite="lax")
    return {"ok": True}


@auth_router.get("/me")
async def me(request: Request):
    return {"authenticated": auth.verify_session_token(request.cookies.get(auth.COOKIE_NAME))}


# --- fuentes ------------------------------------------------------------

VALID_FIELDS = {
    "id", "name", "status", "active", "sort_order", "version",
    "page_count", "digest", "origin", "created_at", "updated_at", "message",
}


@router.get("/sources")
async def list_sources():
    docs = await db.list_documents()
    rows = []
    for d in docs:
        digest = d.get("digest") or ""
        rows.append({
            "id": d["id"], "name": d["name"], "status": d["status"],
            "active": bool(d.get("active")), "sort_order": d.get("sort_order"),
            "version": d.get("version", 1), "origin": d.get("origin", "api"),
            "page_count": d.get("page_count"), "digest_chars": len(digest),
            "created_at": d.get("created_at"), "updated_at": d.get("updated_at"),
            "message": d.get("message"),
        })
    rows.sort(key=lambda r: (r["sort_order"] is not None,
                             r["sort_order"] or 10**9, r["created_at"] or ""))
    return {"sources": rows}


class SourcePatch(BaseModel):
    active: bool | None = None


@router.patch("/sources/{document_id}")
async def patch_source(document_id: str, body: SourcePatch):
    doc = await db.get_document(document_id)
    if not doc:
        raise HTTPException(404, "Documento no encontrado")
    fields: dict = {}
    if body.active is not None:
        if doc["status"] != "ready":
            raise HTTPException(400, f"El documento está '{doc['status']}', no 'ready'")
        fields["active"] = body.active
    if not fields:
        raise HTTPException(400, "Nada que actualizar")
    await db.update_document_fields(document_id, fields)
    await db.insert_event(
        "activate" if fields.get("active") else "deactivate",
        document_id=document_id,
        detail={"name": doc["name"]},
    )
    return {"ok": True, "active": fields.get("active", bool(doc.get("active")))}


class ReorderIn(BaseModel):
    ids: list[str]


@router.post("/sources/reorder")
async def reorder(body: ReorderIn):
    for idx, document_id in enumerate(body.ids, start=1):
        await db.update_document_fields(document_id, {"sort_order": idx})
    await db.insert_event("reorder", detail={"ids": body.ids})
    return {"ok": True, "count": len(body.ids)}


@router.post("/sources/{document_id}/archive")
async def archive(document_id: str):
    doc = await db.get_document(document_id)
    if not doc:
        raise HTTPException(404, "Documento no encontrado")
    await db.update_document_fields(document_id, {"status": "archived", "active": False})
    await db.insert_event("archive", document_id=document_id, detail={"name": doc["name"]})
    return {"ok": True}


@router.post("/sources/{document_id}/restore")
async def restore(document_id: str):
    doc = await db.get_document(document_id)
    if not doc:
        raise HTTPException(404, "Documento no encontrado")
    await db.update_document_fields(document_id, {"status": "ready"})
    await db.insert_event("unarchive", document_id=document_id, detail={"name": doc["name"]})
    return {"ok": True}


# --- versiones ----------------------------------------------------------

@router.get("/sources/{document_id}/versions")
async def versions(document_id: str):
    doc = await db.get_document(document_id)
    if not doc:
        raise HTTPException(404, "Documento no encontrado")
    rows = await db.list_document_versions(document_id)
    return {"document_id": document_id, "current_version": doc.get("version", 1),
            "versions": rows}


class RestoreIn(BaseModel):
    note: str | None = None


@router.post("/sources/{document_id}/versions/{version}/restore")
async def restore_version(document_id: str, version: int, body: RestoreIn):
    doc = await db.get_document(document_id)
    if not doc:
        raise HTTPException(404, "Documento no encontrado")
    snap = await db.get_document_version(document_id, version)
    if not snap:
        raise HTTPException(404, "Versión no encontrada")
    if not (snap.get("digest") or "").strip():
        raise HTTPException(400, "La versión no tiene digest para restaurar")

    # snapshot del estado ACTUAL antes de devolver el digest viejo
    await db.insert_document_version({
        "document_id": document_id, "version": int(doc.get("version", 1)),
        "name": doc["name"], "digest": doc.get("digest"),
        "page_count": doc.get("page_count"), "storage_path": doc.get("storage_path"),
        "file_uri": doc.get("file_uri"),
        "note": body.note or f"Guardia previo a restaurar v{version}",
        "created_by": "gestor",
    })
    new_version = int(doc.get("version", 1)) + 1
    await db.update_document_fields(document_id, {
        "digest": snap["digest"], "version": new_version, "origin": "restore",
    })
    await db.insert_event(
        "restore", document_id=document_id,
        detail={"restored_version": version, "new_version": new_version,
                "name": snap["name"]},
    )
    return {"ok": True, "new_version": new_version}


# --- subida + jobs ------------------------------------------------------

class UploadInitIn(BaseModel):
    filename: str
    size: int
    mode: str = "new"
    document_id: str | None = None


def _safe_filename(name: str) -> str:
    base = Path(name).name
    ext = Path(base).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Solo se aceptan {', '.join(sorted(ALLOWED_EXTENSIONS))}")
    stem = "".join(c if c.isalnum() or c in "._- " else "_" for c in Path(base).stem).strip()
    return f"{stem or 'documento'}{ext}"


@router.post("/uploads/init")
async def init_upload(body: UploadInitIn):
    if body.size <= 0:
        raise HTTPException(400, "Archivo vacío")
    if body.size > MAX_FILE_BYTES:
        raise HTTPException(400, "El archivo supera los 50MB")
    filename = _safe_filename(body.filename)
    storage_path = f"{uuid.uuid4()}/{filename}"

    if body.mode == "replace":
        doc = await db.get_document(body.document_id or "")
        if not doc:
            raise HTTPException(404, "Documento a reemplazar no encontrado")
    else:
        body.document_id = None

    signed_url = await storage().create_signed_upload_url(storage_path)
    job = await db.insert_knowledge_job({
        "document_id": body.document_id, "filename": filename,
        "storage_path": storage_path, "content_type": _content_type(filename),
        "mode": body.mode, "status": "signed",
    })
    return {"job_id": job["id"], "upload_url": signed_url,
            "storage_path": storage_path, "filename": filename}


def _content_type(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }.get(ext, "application/octet-stream")


@router.post("/jobs/{job_id}/run")
async def run_job(job_id: str):
    from google import genai as genai_module
    from knowledge.jobs import run_job as _run

    job = await db.get_knowledge_job(job_id)
    if not job:
        raise HTTPException(404, "Job no encontrado")
    try:
        snap = await _run(job_id, storage(), genai_module.Client(api_key=config.GEMINI_API_KEY))
    except KeyError:
        raise HTTPException(404, "Job no encontrado")
    except Exception as exc:
        logger.exception("[api] job %s falló", job_id)
        await db.update_knowledge_job(job_id, {"status": "error", "error": str(exc)[:500]})
        raise HTTPException(500, str(exc)[:300])
    return snap


@router.get("/jobs/{job_id}")
async def job_status(job_id: str):
    job = await db.get_knowledge_job(job_id)
    if not job:
        raise HTTPException(404, "Job no encontrado")
    return {"id": job["id"], "filename": job["filename"], "mode": job["mode"],
            **_snapshot(job)}


# --- lectura / transparencia --------------------------------------------

@router.get("/budget")
async def budget():
    docs = [d for d in await db.list_active_documents()]
    per = [{"id": d["id"], "name": d["name"], "chars": len(d.get("digest") or "")}
           for d in docs]
    used = sum(p["chars"] for p in per)
    return {"budget": MAX_KNOWLEDGE_CHARS, "used": used,
            "over_budget": used > MAX_KNOWLEDGE_CHARS,
            "active_count": len(docs), "docs": per}


@router.get("/preview")
async def preview():
    from pdf.digest import build_knowledge_context
    from prompt import build_system_prompt

    docs = await db.list_active_documents()
    ids = [d["id"] for d in docs]
    knowledge = await build_knowledge_context(ids)
    prompt = build_system_prompt(knowledge)
    return {"doc_ids": ids, "knowledge_chars": len(knowledge),
            "prompt_chars": len(prompt), "prompt": prompt}


@router.get("/export")
async def export(format: str = "json"):
    """Respaldo completo: documents + digest + chunks + versiones + eventos.
    Descargable y desacoplado: sin él, la base de conocimiento vive solo
    en el Supabase ajeno (riesgo declarado)."""
    docs = await db.list_documents()
    out_docs = []
    for d in docs:
        chunks = await db.get_document_chunks(d["id"])
        versions = await db.list_document_versions(d["id"])
        out_docs.append({
            **{k: d.get(k) for k in ("id", "name", "status", "active", "sort_order",
                                      "version", "origin", "created_at", "updated_at",
                                      "page_count", "digest")},
            "chunks_count": len(chunks),
            "chunk_text": [c["content"] for c in chunks],
            "versions": versions,
        })
    payload = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "knowledge_base": "Manglara",
        "documents": out_docs,
        "events": await db.list_events(),
    }
    if format == "md":
        md = [
            "# Respaldo de conocimiento — Manglara\n",
            f"_Exportado: {payload['exported_at']}_\n",
        ]
        for doc in out_docs:
            md.append(f"\n## {doc['name']}\n")
            md.append(
                f"estado: {doc['status']} · activo: {doc['active']} · "
                f"versión: {doc['version']} · chunks: {doc['chunks_count']}\n"
            )
            md.append("### Digest\n")
            md.append(doc["digest"] or "_(sin digest)_")
            md.append("\n\n### Contenido completo (chunks)\n")
            md.extend(f"#### chunk {i}\n{c}\n" for i, c in enumerate(doc["chunk_text"], 1))
        content = "\n".join(md).encode("utf-8")
        media = "text/markdown; charset=utf-8"
        fname = "manglara-conocimiento.md"
    else:
        content = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        media = "application/json; charset=utf-8"
        fname = "manglara-conocimiento.json"
    return Response(content=content, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})
