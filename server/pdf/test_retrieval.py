"""Tests de assemble_context. Se corren sin red: `python pdf/test_retrieval.py`."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pdf.retrieval import assemble_context  # noqa: E402

CHUNKS = [
    {"document_id": "a", "page_num": 3, "content": " Uno "},
    {"document_id": "b", "page_num": 7, "content": "Dos"},
]


def test_names_source_in_header():
    out = assemble_context(CHUNKS, names={"a": "Módulo 1", "b": "Módulo 2"})
    assert out == "[Módulo 1 — Página 3]\nUno\n\n---\n\n[Módulo 2 — Página 7]\nDos", out


def test_without_names_keeps_page_header():
    out = assemble_context(CHUNKS)
    assert out == "[Página 3]\nUno\n\n---\n\n[Página 7]\nDos", out


def test_unknown_document_falls_back_to_page():
    out = assemble_context(CHUNKS[:1], names={"b": "Módulo 2"})
    assert out == "[Página 3]\nUno", out


def test_respects_max_chars():
    out = assemble_context(CHUNKS, max_chars=20)
    assert out == "[Página 3]\nUno", out


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
