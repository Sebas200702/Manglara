import asyncio
import logging

from fastembed import TextEmbedding

from db import search_chunks, search_chunks_multi

logger = logging.getLogger(__name__)

_embedder: TextEmbedding | None = None


def get_embedder() -> TextEmbedding:
    global _embedder
    if _embedder is None:
        _embedder = TextEmbedding(
            model_name="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
            max_length=512,
        )
    return _embedder


def embed_query(query: str) -> list[float]:
    emb = list(get_embedder().embed([f"query: {query}"]))
    return emb[0].tolist()


def assemble_context(chunks: list[dict], max_chars: int = 4000) -> str:
    parts = []
    total = 0
    for c in chunks:
        header = f"[Página {c['page_num']}]"
        content = c["content"].strip()
        entry = f"{header}\n{content}"
        if total + len(entry) > max_chars:
            break
        parts.append(entry)
        total += len(entry)
    return "\n\n---\n\n".join(parts)


async def retrieve_context(
    document_ids: str | list[str], query: str, top_k: int = 5
) -> str:
    # Embedding is CPU-bound (ONNX); run off the event loop so it never
    # stalls the realtime audio stream while the user is speaking.
    embedding = await asyncio.to_thread(embed_query, query)
    if isinstance(document_ids, str):
        chunks = await search_chunks(document_ids, embedding, top_k=top_k)
    else:
        chunks = await search_chunks_multi(document_ids, embedding, top_k=top_k)
    if not chunks:
        return ""
    return assemble_context(chunks)
