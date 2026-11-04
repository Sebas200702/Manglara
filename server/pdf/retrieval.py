import asyncio
import logging

import db
from knowledge.embedding import embed_texts

logger = logging.getLogger(__name__)


def assemble_context(
    chunks: list[dict], max_chars: int = 4000, names: dict[str, str] | None = None
) -> str:
    parts = []
    total = 0
    for c in chunks:
        # Naming the source lets the model attribute a fact to its cartilla
        # instead of mixing pages from different documents.
        name = (names or {}).get(c.get("document_id", ""))
        header = f"[{name} — Página {c['page_num']}]" if name else f"[Página {c['page_num']}]"
        content = c["content"].strip()
        entry = f"{header}\n{content}"
        if total + len(entry) > max_chars:
            break
        parts.append(entry)
        total += len(entry)
    return "\n\n---\n\n".join(parts)


async def retrieve_context(
    document_ids: str | list[str],
    query: str,
    top_k: int = 8,
    names: dict[str, str] | None = None,
) -> str:
    # Ya no hay modelo ONNX local: el embedding es una llamada de red vía
    # `embed_texts()`, y se espera directamente en el event loop (no bloquea
    # el streaming de audio del WS porque se lanza con asyncio.create_task).
    embedding = (await embed_texts([query], task_type="RETRIEVAL_QUERY"))[0]
    if isinstance(document_ids, str):
        chunks = await db.search_chunks(document_ids, embedding, top_k=top_k)
    else:
        chunks = await db.search_chunks_multi(list(document_ids), embedding, top_k=top_k)
    if not chunks:
        return ""
    return assemble_context(chunks, names=names)
