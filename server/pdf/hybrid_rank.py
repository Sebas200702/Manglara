"""Hybrid ranking of knowledge passages for the voice RAG.

Stored chunks are large (about 5,000 chars on average) and the injected
context is capped at 4,000 chars, so ranking whole chunks by vector alone
injected at most one chunk, usually the same generic "conclusions" chunk for
every question. Here every chunk is split into ~700-char passages, and each
passage is scored by BM25 keyword relevance plus a smaller share of its
chunk's vector similarity (the vector share keeps paraphrases and questions
in other languages working).

Measured offline on the eval dataset (37 cases, 114 expected facts): fact
recall of the injected context went from 4% to 54%.
"""

import math
import re
import unicodedata

PASSAGE_CHARS = 700
VECTOR_WEIGHT = 0.15

_STOPWORDS = set(
    "de la el los las y en que un una del al por para con se su sus es lo como "
    "cual cuales quien quienes tiene tienen sobre este esta mas the and for".split()
)
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?:])\s+|\n+")


def _normalize(text: str) -> str:
    return unicodedata.normalize("NFKD", text.lower()).encode("ascii", "ignore").decode()


def tokens(text: str) -> list[str]:
    return [
        w for w in re.findall(r"[a-z0-9]+", _normalize(text))
        if len(w) > 2 and w not in _STOPWORDS
    ]


def passages(text: str, size: int = PASSAGE_CHARS) -> list[str]:
    """Split text on sentence/line boundaries into passages of about `size` chars."""
    out: list[str] = []
    buf = ""
    for sentence in _SENTENCE_SPLIT.split(text):
        sentence = sentence.strip()
        if not sentence:
            continue
        if buf and len(buf) + len(sentence) > size:
            out.append(buf)
            buf = ""
        buf = f"{buf} {sentence}" if buf else sentence
    if buf:
        out.append(buf)
    return out


def _bm25(query: list[str], docs: list[list[str]], k1: float = 1.5, b: float = 0.75) -> list[float]:
    n = len(docs)
    avg_len = sum(len(d) for d in docs) / n or 1.0
    doc_sets = [set(d) for d in docs]
    df = {w: sum(1 for s in doc_sets if w in s) for w in set(query)}
    scores = []
    for doc in docs:
        tf: dict[str, int] = {}
        for w in doc:
            tf[w] = tf.get(w, 0) + 1
        score = 0.0
        for w in query:
            if w in tf:
                idf = math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5))
                score += idf * tf[w] * (k1 + 1) / (tf[w] + k1 * (1 - b + b * len(doc) / avg_len))
        scores.append(score)
    return scores


def rank_passages(query: str, chunks: list[dict], vector_weight: float = VECTOR_WEIGHT) -> list[dict]:
    """Rank passages of `chunks` (rows with content, page_num and cosine
    `distance`) for `query`. Returns passage dicts, best first."""
    items = [(c, p) for c in chunks for p in passages(c["content"])]
    if not items:
        return []
    keyword = _bm25(tokens(query), [tokens(p) for _, p in items])
    top_keyword = max(keyword) or 1.0
    sims = [1.0 - c["distance"] for c in chunks]
    lo, hi = min(sims), max(sims)
    span = (hi - lo) or 1.0
    scored = []
    for (c, p), kw in zip(items, keyword):
        vector = (1.0 - c["distance"] - lo) / span
        scored.append((vector_weight * vector + (1 - vector_weight) * kw / top_keyword, c, p))
    scored.sort(key=lambda s: s[0], reverse=True)
    return [
        {"document_id": c["document_id"], "content": p, "page_num": c["page_num"],
         "score": score}
        for score, c, p in scored
    ]
