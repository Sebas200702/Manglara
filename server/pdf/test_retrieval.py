"""Tests of the knowledge retrieval used by the voice session (RAG).

Run without pytest or network, from `server/`: `python -m pdf.test_retrieval`.
They need the required env of config.py (dummy values are enough).
"""

import asyncio

from pdf import retrieval
from pdf.hybrid_rank import passages, rank_passages

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


GENERIC = (
    "Conclusiones generales del proyecto. El trabajo conjunto entre las organizaciones "
    "permitió fortalecer el aprendizaje y ajustar estrategias de implementación. " * 20
)
MODULE5 = (
    "Módulo 5. Innovación y empleos sostenibles. " + "Texto de contexto sobre empleo. " * 40
    + "La herramienta IKIGAI ayuda a alinear tus pasiones, lo que haces bien y lo que el "
    "mundo necesita con un proyecto de vida sostenible. " + "Más texto del módulo. " * 40
)


def chunk(content, distance, page=1):
    return {"document_id": "d", "content": content, "page_num": page,
            "chunk_index": 0, "distance": distance}


def test_passages():
    ps = passages(MODULE5, size=700)
    check(len(ps) > 1, "large chunk is split into several passages")
    check(all(len(p) <= 900 for p in ps), "passages stay near the target size")
    check(any("IKIGAI" in p for p in ps), "no text is lost when splitting")


def test_rank_prefers_keyword_passage_over_generic_chunk():
    # The generic chunk is the closest by vector (the "hub" chunk that used to
    # win every query); the keyword passage must still come first.
    ranked = rank_passages(
        "¿Qué es IKIGAI en el módulo 5?",
        [chunk(GENERIC, 0.40, page=4), chunk(MODULE5, 0.45, page=9)],
    )
    check("IKIGAI" in ranked[0]["content"], "passage with the query keyword ranks first")
    check(ranked[0]["page_num"] == 9, "ranked passage keeps its page number")


def test_rank_falls_back_to_vector_without_keywords():
    ranked = rank_passages(
        "What is this about?",
        [chunk("Uno. " * 50, 0.60, page=1), chunk("Dos. " * 50, 0.20, page=2)],
    )
    check(ranked[0]["page_num"] == 2, "with no shared keywords, vector similarity decides")


def test_assemble_never_drops_everything():
    big = [chunk("x " * 3000, 0.1, page=1)]
    ctx = retrieval.assemble_context(big, max_chars=4000)
    check(ctx == "", "a single passage larger than the budget is skipped, not truncated")
    mixed = [chunk("x " * 3000, 0.1, page=1), chunk("pequeño texto útil", 0.2, page=2)]
    ctx = retrieval.assemble_context(mixed, max_chars=4000)
    check("pequeño texto útil" in ctx, "an oversized passage does not block the ones after it")


def test_retrieve_context_end_to_end():
    async def fake_embed(texts, task_type="RETRIEVAL_DOCUMENT"):
        return [[0.0] * 3 for _ in texts]

    async def fake_search(ids, embedding, top_k=10):
        return [chunk(GENERIC, 0.40, page=4), chunk(MODULE5, 0.45, page=9)]

    saved = (retrieval.embed_texts, retrieval.db.search_chunks_multi)
    retrieval.embed_texts = fake_embed
    retrieval.db.search_chunks_multi = fake_search
    try:
        ctx = asyncio.run(retrieval.retrieve_context(["d"], "¿Qué es IKIGAI?"))
    finally:
        retrieval.embed_texts, retrieval.db.search_chunks_multi = saved
    check("IKIGAI" in ctx, "retrieved context contains the relevant passage")
    check(len(ctx) <= 4000, "retrieved context respects the 4000-char budget")
    check(ctx.startswith("[Página 9]"), "most relevant passage comes first")


if __name__ == "__main__":
    test_passages()
    test_rank_prefers_keyword_passage_over_generic_chunk()
    test_rank_falls_back_to_vector_without_keywords()
    test_assemble_never_drops_everything()
    test_retrieve_context_end_to_end()
    print(f"{_passed} checks OK")
