import asyncio
import logging

import db
from knowledge.embedding import embed_texts
from pdf.hybrid_rank import rank_passages

logger = logging.getLogger(__name__)


def assemble_context(
    chunks: list[dict], max_chars: int = 4000, names: dict[str, str] | None = None
) -> str:
    parts = []
    total = 0
    for c in chunks:
        # Naming the source lets the model attribute a fact to its cartilla
        # instead of mixing pages from different documents. The label counts
        # toward max_chars like the content.
        name = (names or {}).get(c.get("document_id", ""))
        page = f"Página {c['page_num']}"
        header = f"[{name} — {page}]" if name else f"[{page}]"
        content = c["content"].strip()
        entry = f"{header}\n{content}"
        if total + len(entry) > max_chars:
            # Skip it and keep filling: one oversized passage must not leave
            # the session without context.
            continue
        parts.append(entry)
        total += len(entry)
    return "\n\n---\n\n".join(parts)


async def retrieve_context(
    document_ids: str | list[str],
    query: str,
    top_k: int = 1000,
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
    # Every chunk of the active set (top_k is above its size) is split into
    # passages and re-ranked by keywords + vector; see pdf/hybrid_rank.py.
    # ~20 ms of pure-Python scoring: run it off the event loop so it never
    # delays the audio frames of other sessions.
    ranked = await asyncio.to_thread(rank_passages, query, chunks)
    return assemble_context(ranked, names=names)
