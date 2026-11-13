"""Offline tests of eval/sources.py (the `--check-sources` check).

Run from `server/`: `python -m eval.test_sources`. Supabase is replaced by
fakes; the runner part needs the dummy env of config.py like test_eval.
"""

import asyncio
import contextlib
import io

from eval import sources

CHUNKS = {"Modulo1.docx": ["La lección 1 dura\n 90 minutos y usa el árbol de problemas."]}


def case(document="Modulo1.docx", quote="dura 90 minutos", case_id="m1"):
    return {"id": case_id, "source": {"document": document, "page": 1, "quote": quote}}


def test_quote_found_ignoring_whitespace():
    assert sources.stale_sources([case()], CHUNKS) == []


def test_missing_quote_is_stale():
    assert sources.stale_sources([case(quote="dura 120 minutos")], CHUNKS) == [
        "m1: quote not found in 'Modulo1.docx'"
    ]


def test_inactive_document_is_stale():
    assert sources.stale_sources([case(document="Viejo.docx")], CHUNKS) == [
        "m1: document 'Viejo.docx' is not active"
    ]


def test_cases_without_source_are_skipped():
    assert sources.stale_sources([{"id": "prompt-fact"}], CHUNKS) == []


# --- active chunks from Supabase (stubbed) -----------------------------------

DOCS = [{"id": "d1", "name": "Modulo1.docx"}, {"id": "d2", "name": "Intro.docx"}]
ROWS = {
    "d1": [{"content": "La lección 1 dura\n 90 minutos", "page_num": 1, "chunk_index": 0}],
    "d2": [{"content": "Tiene 5 módulos.", "page_num": 3, "chunk_index": 0}],
}


async def list_docs():
    return DOCS


async def get_chunks(document_id):
    return ROWS[document_id]


def test_load_active_chunks_groups_by_document_name():
    chunks = asyncio.run(sources.load_active_chunks(list_docs, get_chunks))
    assert chunks == {"Modulo1.docx": ["La lección 1 dura\n 90 minutos"],
                      "Intro.docx": ["Tiene 5 módulos."]}, chunks


def test_check_sources_reports_and_exits():
    good = [case(), {"id": "p1"}]
    code, lines = asyncio.run(sources.check_sources(good, list_docs, get_chunks))
    assert code == 0 and lines == ["1/1 cited sources found in the active documents"], lines

    bad = [case(), case(document="Viejo.docx", case_id="m2")]
    code, lines = asyncio.run(sources.check_sources(bad, list_docs, get_chunks))
    assert code == 1, code
    assert lines == ["[STALE] m2: document 'Viejo.docx' is not active",
                     "1/2 cited sources found in the active documents"], lines


def test_check_sources_without_supabase_gives_no_verdict():
    async def down():
        raise RuntimeError("supabase down")

    code, lines = asyncio.run(sources.check_sources([case()], down, get_chunks))
    assert code == 2 and "supabase down" in lines[0], lines


def test_runner_check_sources_flag_uses_no_gemini():
    from eval import runner

    calls = []

    async def fake_check(cases):
        calls.append(len(cases))
        return 1, ["[STALE] x", "0/1 cited sources found in the active documents"]

    saved = sources.check_active_sources
    sources.check_active_sources = fake_check
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            runner.main(["--check-sources", "--ids", "a01,m1-video-causas"])
        raise AssertionError("runner --check-sources must exit with the check's code")
    except SystemExit as e:
        assert e.code == 1, e.code
    finally:
        sources.check_active_sources = saved
    assert calls == [2], calls
    assert "[STALE] x" in out.getvalue(), out.getvalue()


def main():
    tests = [(n, f) for n, f in globals().items() if n.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"  ok  {name}")
    print(f"\n{len(tests)} tests OK")


if __name__ == "__main__":
    main()
