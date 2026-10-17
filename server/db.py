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
    name: str,
    storage_path: str,
    page_count: int | None = None,
    file_uri: str | None = None,
    status: str = "ready",
    active: bool = False,
    origin: str = "api",
) -> dict:
    """Crea la fila de documento y devuelve el registro completo.

    active=False por defecto: la activación la decide el gestor en el
    panel (documents.active es LA fuente de verdad, migración 006).
    """
    payload = {
        "name": name,
        "storage_path": storage_path,
        "page_count": page_count,
        "file_uri": file_uri,
        "status": status,
        "active": active,
        "origin": origin,
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE}/documents", json=payload, headers=HEADERS)
        resp.raise_for_status()
        return resp.json()[0]


async def insert_chunks(chunks: list[dict]):
    if not chunks:
        return
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE}/chunks", json=chunks, headers=HEADERS)
        resp.raise_for_status()


async def search_chunks(
    document_id: str, embedding: list[float], top_k: int = 5
) -> list[dict]:
    """Búsqueda vectorial LOCAL en un solo documento (mismo motivo que
    search_chunks_multi: el RPC vía REST devuelve vacíos erráticos)."""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{BASE}/chunks",
            params={
                "document_id": f"eq.{document_id}",
                "select": "document_id,content,page_num,chunk_index,embedding",
            },
            headers=HEADERS,
        )
        resp.raise_for_status()
        rows = resp.json()
    return _rank_by_cosine(rows, embedding, top_k)


async def search_chunks_multi(
    document_ids: list[str], embedding: list[float], top_k: int = 10
) -> list[dict]:
    """Búsqueda vectorial LOCAL sobre las filas de chunks.

    El RPC search_chunks_multi vía PostgREST devuelve vacíos erráticos
    (RLS en chunks sin políticas + cast JSON→vector(384) inestable); con
    ~100 chunks es más barato y determinístico traer las filas del set
    activo y hacer el cosine en Python.
    """
    if not document_ids:
        return []
    id_list = ",".join(document_ids)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{BASE}/chunks",
            params={
                "document_id": f"in.({id_list})",
                "select": "document_id,content,page_num,chunk_index,embedding",
            },
            headers=HEADERS,
        )
        resp.raise_for_status()
        rows = resp.json()
    return _rank_by_cosine(rows, embedding, top_k)


def _rank_by_cosine(rows: list[dict], embedding: list[float], top_k: int) -> list[dict]:
    """Ordena por similarity coseno y devuelve las top_k con 'distance'.

    PostgREST devuelve `embedding` como string pgvector "[0.1,0.2,...]"
    (no como array JSON); aceptamos ambas formas.
    """
    def to_vec(raw) -> list[float] | None:
        if isinstance(raw, list):
            return raw if all(isinstance(x, (int, float)) for x in raw) else None
        if isinstance(raw, str) and raw.startswith("["):
            try:
                return [float(x) for x in raw[1:-1].split(",") if x.strip()]
            except ValueError:
                return None
        return None

    def norm(v: list[float]) -> float:
        return sum(x * x for x in v) ** 0.5 or 1.0

    target = embedding
    target_norm = norm(target)
    scored: list[tuple[float, dict]] = []
    for row in rows:
        vec = to_vec(row.get("embedding"))
        if not vec:
            continue
        dot = sum(a * b for a, b in zip(vec, target))
        similarity = dot / (norm(vec) * target_norm)
        scored.append((similarity, row))
    scored.sort(key=lambda s: s[0], reverse=True)
    return [
        {
            "document_id": row["document_id"],
            "content": row["content"],
            "page_num": row["page_num"],
            "chunk_index": row["chunk_index"],
            "distance": 1.0 - similarity,
        }
        for similarity, row in scored[:top_k]
    ]


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

async def activate_document(document_id: str) -> None:
    """Enciende documents.active (fuente de verdad para las sesiones)."""
    await update_document_fields(document_id, {"active": True})


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
