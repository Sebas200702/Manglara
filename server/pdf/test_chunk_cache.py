"""Tests of the chunk cache in db.py.

Run without pytest or network, from `server/`: `python -m pdf.test_chunk_cache`.
They need the required env of config.py (dummy values are enough).
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402

ROWS = [
    {"document_id": "a", "content": "agua", "page_num": 1, "chunk_index": 0, "embedding": "[1,0]"},
    {"document_id": "b", "content": "residuos", "page_num": 2, "chunk_index": 0, "embedding": "[0,1]"},
]


class FakeResponse:
    def raise_for_status(self):
        pass

    def json(self):
        return [dict(r) for r in ROWS]


class FakeClient:
    calls: list[dict] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None, headers=None):
        FakeClient.calls.append(params)
        return FakeResponse()

    async def post(self, url, json=None, headers=None):
        return FakeResponse()

    async def patch(self, url, params=None, json=None, headers=None):
        return FakeResponse()

    async def delete(self, url, params=None, headers=None):
        return FakeResponse()


def setup():
    db.httpx.AsyncClient = FakeClient
    FakeClient.calls = []
    db._chunk_cache.clear()


def test_ranks_by_similarity():
    setup()
    out = asyncio.run(db.search_chunks_multi(["a", "b"], [0.0, 1.0], top_k=1))
    assert [c["content"] for c in out] == ["residuos"], out


def test_second_search_reuses_cache():
    setup()
    asyncio.run(db.search_chunks_multi(["b", "a"], [1.0, 0.0]))
    asyncio.run(db.search_chunks_multi(["a", "b"], [0.0, 1.0]))
    assert len(FakeClient.calls) == 1, FakeClient.calls


def test_expired_cache_refetches():
    setup()
    asyncio.run(db.search_chunks("a", [1.0, 0.0]))
    key = next(iter(db._chunk_cache))
    stamp, rows = db._chunk_cache[key]
    db._chunk_cache[key] = (stamp - db.CHUNK_CACHE_TTL_S - 1, rows)
    asyncio.run(db.search_chunks("a", [1.0, 0.0]))
    assert len(FakeClient.calls) == 2, FakeClient.calls


def test_insert_chunks_invalidates_cache():
    setup()
    asyncio.run(db.search_chunks("a", [1.0, 0.0]))
    asyncio.run(db.insert_chunks([{"document_id": "a"}]))
    asyncio.run(db.search_chunks("a", [1.0, 0.0]))
    assert len(FakeClient.calls) == 2, FakeClient.calls


def _cached_then(mutation):
    setup()
    asyncio.run(db.search_chunks_multi(["a", "b"], [1.0, 0.0]))
    asyncio.run(mutation())
    asyncio.run(db.search_chunks_multi(["a", "b"], [1.0, 0.0]))
    return len(FakeClient.calls)


def test_delete_chunks_invalidates_cache():
    # Re-ingesting a document (knowledge/jobs.py) deletes its chunks first.
    assert _cached_then(lambda: db.delete_chunks_by_document("a")) == 2


def test_delete_document_invalidates_cache():
    assert _cached_then(lambda: db.delete_document("a")) == 2


def test_document_update_invalidates_cache():
    # Activate, archive, restore and rollback all go through update_document_fields.
    assert _cached_then(lambda: db.update_document_fields("a", {"active": False})) == 2


def test_cached_rows_are_not_mutated_by_ranking():
    setup()
    first = asyncio.run(db.search_chunks_multi(["a", "b"], [0.0, 1.0], top_k=2))
    first[0]["content"] = "changed"
    again = asyncio.run(db.search_chunks_multi(["a", "b"], [0.0, 1.0], top_k=2))
    assert again[0]["content"] == "residuos", again


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
