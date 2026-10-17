"""Vectorización por la API de Gemini.

Reemplaza a fastembed+ONNX: en serverless no hay sitio para bajar el
modelo local y sí hay una API que ya usamos. gemini-embedding-001
admite output_dimensionality de 128 a 3072; pedimos 384 para mantener
la columna `chunks.embedding vector(384)` sin migración destructiva.
"""

import asyncio
import logging
import os

import httpx
from google import genai
from google.genai import types

import db

logger = logging.getLogger(__name__)

EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
EMBEDDING_DIM = int(os.getenv("GEMINI_EMBEDDING_DIM", "384"))
EMBED_BATCH = int(os.getenv("GEMINI_EMBEDDING_BATCH", "32"))
EMBED_MAX_RETRIES = 4
_upsert_page_size = EMBED_BATCH

_embedder: genai.Client | None = None


def get_embedding_client() -> genai.Client:
    global _embedder
    if _embedder is None:
        from config import GEMINI_API_KEY

        _embedder = genai.Client(api_key=GEMINI_API_KEY)
    return _embedder


def _normalize(values: list[float]) -> list[float]:
    """Los vectores truncados (<=3072 dims) no vienen normalizados según la
    documentación. La distancia coseno (<=>) es invariante a la escala,
    pero al dejarlos unitarios el índice y la similitud quedan canónicos."""
    norm = sum(v * v for v in values) ** 0.5
    if not norm:
        return values
    return [v / norm for v in values]


async def _embed_with_backoff(client, texts: list[str], task_type: str) -> list[list[float]]:
    config = types.EmbedContentConfig(
        output_dimensionality=EMBEDDING_DIM,
        task_type=task_type,
    )
    for attempt in range(EMBED_MAX_RETRIES):
        try:
            resp = await client.aio.models.embed_content(
                model=EMBEDDING_MODEL, contents=texts, config=config
            )
            return [_normalize(list(e.values)) for e in resp.embeddings]
        except Exception as exc:  # 429/5xx/timeout; la API es esencial
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