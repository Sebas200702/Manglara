import logging

import httpx

from config import SUPABASE_URL, SUPABASE_SERVICE_KEY

logger = logging.getLogger(__name__)

BASE = f"{SUPABASE_URL}/rest/v1"
HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


async def insert_document(
    name: str, storage_path: str, page_count: int, file_uri: str | None = None
) -> str:
    payload = {
        "name": name,
        "storage_path": storage_path,
        "page_count": page_count,
        "file_uri": file_uri,
        "status": "ready",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE}/documents", json=payload, headers=HEADERS)
        resp.raise_for_status()
        data = resp.json()
        return data[0]["id"]


async def insert_chunks(chunks: list[dict]):
    if not chunks:
        return
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE}/chunks", json=chunks, headers=HEADERS)
        resp.raise_for_status()


async def search_chunks(
    document_id: str, embedding: list[float], top_k: int = 5
) -> list[dict]:
    payload = {
        "p_document_id": document_id,
        "p_embedding": embedding,
        "p_top_k": top_k,
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE}/rpc/search_chunks",
            json=payload,
            headers=HEADERS,
        )
        resp.raise_for_status()
        return resp.json()


async def search_chunks_multi(
    document_ids: list[str], embedding: list[float], top_k: int = 10
) -> list[dict]:
    payload = {
        "p_document_ids": document_ids,
        "p_embedding": embedding,
        "p_top_k": top_k,
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE}/rpc/search_chunks_multi",
            json=payload,
            headers=HEADERS,
        )
        resp.raise_for_status()
        return resp.json()


async def get_document(document_id: str) -> dict | None:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE}/documents",
            params={"id": f"eq.{document_id}"},
            headers={**HEADERS, "Prefer": "return=representation"},
        )
        resp.raise_for_status()
        data = resp.json()
        return data[0] if data else None


async def list_documents() -> list[dict]:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE}/documents",
            params={"order": "created_at.desc"},
            headers={**HEADERS, "Prefer": "return=representation"},
        )
        resp.raise_for_status()
        return resp.json()


async def get_document_chunks(document_id: str) -> list[dict]:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE}/chunks",
            params={
                "document_id": f"eq.{document_id}",
                "select": "content,page_num,chunk_index",
                "order": "chunk_index.asc",
            },
            headers=HEADERS,
        )
        resp.raise_for_status()
        return resp.json()


async def update_document_digest(document_id: str, digest: str):
    async with httpx.AsyncClient() as client:
        resp = await client.patch(
            f"{BASE}/documents",
            params={"id": f"eq.{document_id}"},
            json={"digest": digest},
            headers=HEADERS,
        )
        resp.raise_for_status()


async def set_document_status(
    document_id: str, status: str, message: str | None = None
):
    payload: dict = {"status": status}
    if message is not None:
        payload["message"] = message
    async with httpx.AsyncClient() as client:
        resp = await client.patch(
            f"{BASE}/documents",
            params={"id": f"eq.{document_id}"},
            json=payload,
            headers=HEADERS,
        )
        resp.raise_for_status()


async def delete_document(document_id: str) -> bool:
    async with httpx.AsyncClient() as client:
        resp = await client.delete(
            f"{BASE}/documents",
            params={"id": f"eq.{document_id}"},
            headers={**HEADERS, "Prefer": "return=representation"},
        )
        resp.raise_for_status()
        return True


# --- gestión de conocimiento (migración 006) --------------------------

async def list_active_documents() -> list[dict]:
    """Filas activas y activas en orden — reemplaza el allowlist hardcodeado
    de sources.py y el estado en memoria del router."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE}/documents",
            params={
                "active": "eq.true",
                "status": "eq.ready",
                "order": "sort_order.asc.nullslast,created_at.asc",
            },
            headers=HEADERS,
        )
        resp.raise_for_status()
        return resp.json()


async def update_document_fields(document_id: str, fields: dict) -> dict:
    from datetime import datetime, timezone

    payload = {**fields, "updated_at": datetime.now(timezone.utc).isoformat()}
    async with httpx.AsyncClient() as client:
        resp = await client.patch(
            f"{BASE}/documents",
            params={"id": f"eq.{document_id}"},
            json=payload,
            headers={**HEADERS, "Prefer": "return=representation"},
        )
        resp.raise_for_status()
        return resp.json()[0]


async def insert_document_version(version: dict) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{BASE}/document_versions", json=version, headers=HEADERS
        )
        resp.raise_for_status()
        return resp.json()[0]


async def list_document_versions(document_id: str) -> list[dict]:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE}/document_versions",
            params={
                "document_id": f"eq.{document_id}",
                "select": "id,version,name,digest,page_count,storage_path,note,created_by,created_at",
                "order": "version.desc",
            },
            headers=HEADERS,
        )
        resp.raise_for_status()
        return resp.json()


async def get_document_version(document_id: str, version: int) -> dict | None:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE}/document_versions",
            params={
                "document_id": f"eq.{document_id}",
                "version": f"eq.{version}",
                "limit": 1,
            },
            headers=HEADERS,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None


async def delete_chunks_by_document(document_id: str) -> None:
    async with httpx.AsyncClient() as client:
        resp = await client.delete(
            f"{BASE}/chunks",
            params={"document_id": f"eq.{document_id}"},
            headers={**HEADERS, "Prefer": "return=minimal"},
        )
        resp.raise_for_status()


# --- jobs -------------------------------------------------------------

async def insert_knowledge_job(job: dict) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE}/knowledge_jobs", json=job, headers=HEADERS)
        resp.raise_for_status()
        return resp.json()[0]


async def get_knowledge_job(job_id: str) -> dict | None:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE}/knowledge_jobs",
            params={"id": f"eq.{job_id}", "limit": 1},
            headers=HEADERS,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None


async def update_knowledge_job(job_id: str, fields: dict) -> None:
    from datetime import datetime, timezone

    async with httpx.AsyncClient() as client:
        resp = await client.patch(
            f"{BASE}/knowledge_jobs",
            params={"id": f"eq.{job_id}"},
            json={**fields, "updated_at": datetime.now(timezone.utc).isoformat()},
            headers=HEADERS,
        )
        resp.raise_for_status()


# --- auditoría --------------------------------------------------------

async def insert_event(
    action: str,
    detail: dict | None = None,
    document_id: str | None = None,
    created_by: str = "gestor",
):
    payload: dict = {"action": action, "created_by": created_by}
    if detail is not None:
        payload["detail"] = detail
    if document_id is not None:
        payload["document_id"] = document_id
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE}/knowledge_events", json=payload, headers=HEADERS)
        resp.raise_for_status()
        return resp.json()[0]


async def list_events(limit: int = 100) -> list[dict]:
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{BASE}/knowledge_events",
            params={
                "select": "id,document_id,action,detail,created_at,created_by",
                "order": "created_at.desc",
                "limit": limit,
            },
            headers=HEADERS,
        )
        resp.raise_for_status()
        return resp.json()
