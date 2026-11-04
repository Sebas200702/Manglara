"""Cases built from the ingested cartillas cite their source. When a document
is replaced or deactivated, its cases stop testing real knowledge, so they are
checked against the active chunks before trusting the eval."""

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
