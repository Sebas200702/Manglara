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
