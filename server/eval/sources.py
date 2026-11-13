"""Check that cases written from a cartilla still match the active documents.

A case with a `source` ({document, page, quote}) tests knowledge that lives in
that document. When the document is replaced or deactivated, the case stops
testing real knowledge, so `python -m eval.runner --check-sources` verifies
each quote against the active chunks in Supabase before trusting a run. It
only reads Supabase and never calls Gemini.

The match is per document name, ignoring whitespace differences; the page is
informative only (chunk pages shift between DOCX conversions).
"""

import re


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def stale_sources(cases: list[dict], chunks_by_document: dict[str, list[str]]) -> list[str]:
    """Return one problem per case whose cited quote is not in its active document."""
    problems = []
    for case in cases:
        source = case.get("source")
        if not source:
            continue
        chunks = chunks_by_document.get(source["document"])
        if chunks is None:
            problems.append(f"{case['id']}: document {source['document']!r} is not active")
            continue
        quote = _flat(source["quote"])
        if not any(quote in _flat(c) for c in chunks):
            problems.append(f"{case['id']}: quote not found in {source['document']!r}")
    return problems


async def load_active_chunks(list_docs, get_chunks) -> dict[str, list[str]]:
    """Chunk texts of every active document, keyed by document name."""
    return {
        d["name"]: [c["content"] for c in await get_chunks(d["id"])]
        for d in await list_docs()
    }


async def check_sources(cases: list[dict], list_docs, get_chunks) -> tuple[int, list[str]]:
    """Exit code (0 all found, 1 stale, 2 Supabase unavailable) and report lines."""
    try:
        chunks = await load_active_chunks(list_docs, get_chunks)
    except Exception as e:
        return 2, [f"could not load the active documents: {type(e).__name__}: {e}; no verdict"]
    problems = stale_sources(cases, chunks)
    cited = sum(1 for c in cases if c.get("source"))
    lines = [f"[STALE] {p}" for p in problems]
    lines.append(f"{cited - len(problems)}/{cited} cited sources found in the active documents")
    return (1 if problems else 0), lines


async def check_active_sources(cases: list[dict]) -> tuple[int, list[str]]:
    """`check_sources` against the production Supabase (read-only)."""
    from db import get_document_chunks, list_active_documents

    return await check_sources(cases, list_active_documents, get_document_chunks)
