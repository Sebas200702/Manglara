"""Tests de eval/sources.py. Sin red: `python -m eval.test_sources`."""

from eval.sources import stale_sources

CHUNKS = {"Modulo1.docx": ["La lección 1 dura\n 90 minutos y usa el árbol de problemas."]}


def case(document="Modulo1.docx", quote="dura 90 minutos"):
    return {"id": "m1", "source": {"document": document, "page": 1, "quote": quote}}


def test_quote_found_ignoring_whitespace():
    assert stale_sources([case()], CHUNKS) == []


def test_missing_quote_is_stale():
    assert stale_sources([case(quote="dura 120 minutos")], CHUNKS) == [
        "m1: quote not found in 'Modulo1.docx'"
    ]


def test_inactive_document_is_stale():
    assert stale_sources([case(document="Viejo.docx")], CHUNKS) == [
        "m1: document 'Viejo.docx' is not active"
    ]


def test_cases_without_source_are_skipped():
    assert stale_sources([{"id": "prompt-fact"}], CHUNKS) == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
