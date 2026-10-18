"""Vectorización por la API de Gemini.

Reemplaza fastembed+ONNX: en serverless no cabe el modelo local y ya
pagamos la API. Modelo: gemini-embedding-2 (8.192 tokens de entrada,
auto-normalización en dims truncadas). Batch REAL vía batchEmbedContents:
1 embedding por texto — con embed_content la v2 agrega TODO el lote en
UN solo vector y sería inútil para RAG.
Dimension 384: mantiene la columna `chunks.embedding vector(384)` sin
migración destructiva.
"""

import asyncio
import logging
import os

import httpx

import db

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-2")
EMBEDDING_DIM = int(os.getenv("GEMINI_EMBEDDING_DIM", "384"))
EMBED_BATCH = int(os.getenv("GEMINI_EMBEDDING_BATCH", "16"))
EMBED_MAX_RETRIES = 4
_upsert_page_size = EMBED_BATCH

_embedder = None


def get_embedding_client():
    """Sigue existiendo para digests (generate_digest usa genai.Client);
    los embeddings ya son solo REST con x-goog-api-key."""
    global _embedder
    if _embedder is None:
        from config import GEMINI_API_KEY
        from google import genai as genai_module

        _embedder = genai_module.Client(api_key=GEMINI_API_KEY)
    return _embedder


def _normalize(values: list[float]) -> list[float]:
    """gemini-embedding-001 con dims != 3072 requiere normalización manual
    según la documentación. Con d coseno no cambia el resultado, pero al
    dejar el vector unitario la comparación queda canónica y da igual si
    más adelante se usa otro índice."""
    norm = sum(v * v for v in values) ** 0.5
    if not norm:
        return values
    return [v / norm for v in values]


async def _embed_with_backoff(client, texts: list[str], task_type: str) -> list[list[float]]:
    """gemini-embedding-2 agrega todas las entradas en UN vector si las pasa
    por `embed_content`, así que el lote va por el endpoint dedicado
    `batchEmbedContents` (REST directo, ver #probe): 1 embedding por texto.
    Retries con backoff ante 429/5xx."""
    base = f"https://generativelanguage.googleapis.com/v1beta/models/{EMBEDDING_MODEL}:batchEmbedContents"
    requests_body = [
        {
            "model": f"models/{EMBEDDING_MODEL}",
            "content": {"parts": [{"text": t}]},
            "taskType": task_type,
            "outputDimensionality": EMBEDDING_DIM,
        }
        for t in texts
    ]
    from config import GEMINI_API_KEY
    headers = {"x-goog-api-key": GEMINI_API_KEY}
    for attempt in range(EMBED_MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=60) as http:
                resp = await http.post(base, headers=headers,
                                       json={"requests": requests_body})
            resp.raise_for_status()
            return [_normalize(e["values"]) for e in resp.json()["embeddings"]]
        except Exception as exc:  # 429/5xx/timeout
            wait = 2 ** attempt * 1.5
            logger.warning(
                "[embedding] lote falló (intento %d/%d): %s — reintento en %.1fs",
                attempt + 1, EMBED_MAX_RETRIES, str(exc)[:160], wait,
            )
            if attempt == EMBED_MAX_RETRIES - 1:
                raise
            await asyncio.sleep(wait)
    raise RuntimeError("unreachable")


async def embed_texts(texts: list[str], task_type: str = "RETRIEVAL_DOCUMENT") -> list[list[float]]:
    client = get_embedding_client()
    out: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        out.extend(await _embed_with_backoff(client, texts[i:i + EMBED_BATCH], task_type))
    return out


def _chunk_rows(document_id: str, chunk_index: int, chunks: list[dict], embeddings: list[list[float]]) -> list[dict]:
    return [
        {
            "document_id": document_id,
            "content": c["content"],
            "page_num": c["page_num"],
            "chunk_index": chunk_index + offset,
            "embedding": emb,
        }
        for offset, (c, emb) in enumerate(zip(chunks, embeddings))
    ]


async def ingest_batch_with_embeddings(
    document_id: str, base_index: int, batch: list[dict], embeddings: list[list[float]]
) -> None:
    """POST directo de las filas del lote, ya con embedding incluido."""
    rows = _chunk_rows(document_id, base_index, batch, embeddings)
    await db.insert_chunks(rows)


async def reembed_document(document_id: str) -> int:
    """Re-vectoriza los chunks ya persistidos (mismo contenido, nuevo modelo).
    UPSERT en 1 request por lote con resolution=merge-duplicates, preservando
    id/PK. Devuelve el número de chunks actualizados."""
    client = get_embedding_client()
    async with httpx.AsyncClient() as http:
        resp = await http.get(
            f"{db.BASE}/chunks",
            params={
                "document_id": f"eq.{document_id}",
                "select": "id,document_id,content,page_num,chunk_index",
                "order": "chunk_index.asc",
            },
            headers=db.HEADERS,
        )
        resp.raise_for_status()
        rows = resp.json()
    total = 0
    for i in range(0, len(rows), _upsert_page_size):
        batch = rows[i:i + _upsert_page_size]
        embeddings = await _embed_with_backoff(
            client, [r["content"] for r in batch], "RETRIEVAL_DOCUMENT"
        )
        for row, emb in zip(batch, embeddings):
            row["embedding"] = emb
        async with httpx.AsyncClient() as http:
            resp = await http.post(
                f"{db.BASE}/chunks?on_conflict=id",
                headers={**db.HEADERS, "Prefer": "resolution=merge-duplicates"},
                json=batch,
            )
            resp.raise_for_status()
        total += len(batch)
    return total