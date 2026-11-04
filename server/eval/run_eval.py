"""Grounding eval: asks Manglara (real Gemini Live session, same prompt,
knowledge preload and retrieval as the voice chat) the questions in
cases.json and fails when she invents or omits facts.

    cd server && .venv/bin/python -m eval.run_eval [--repeat 3] [--case ID]
    cd server && .venv/bin/python -m eval.run_eval --check-sources

Exits 1 when the pass rate is below --min-pass, so it can gate a deploy, and
2 when a session could not run (network, quota): no verdict either way.
Costs one Live session per case and repetition, plus one retry on error.
"""

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

from db import list_active_documents, list_document_chunks
from eval.scoring import score
from eval.sources import stale_sources
from gemini_client import GeminiLiveClient
from pdf.digest import build_knowledge_context
from pdf.retrieval import retrieve_context
from prompt import CONTEXT_NOTE, build_system_prompt

CASES_PATH = Path(__file__).with_name("cases.json")
ANSWER_TIMEOUT_S = 60


async def ask(system_prompt: str, docs: list[dict], question: str) -> str:
    gemini = GeminiLiveClient()
    gemini.log_transcripts = False
    parts: list[str] = []
    done = asyncio.Event()

    async def on_transcript(role: str, text: str):
        if role == "model":
            parts.append(text)

    async def on_turn_complete():
        done.set()

    gemini.transcript_callback = on_transcript
    gemini.turn_complete_callback = on_turn_complete
    await gemini.connect(system_prompt=system_prompt)

    async def drain_audio():
        async for _ in gemini.receive_loop():
            pass

    receiver = asyncio.create_task(drain_audio())
    try:
        if docs:
            names = {d["id"]: d["name"] for d in docs}
            context = await retrieve_context([d["id"] for d in docs], question, names=names)
            if context:
                await gemini.inject_context(CONTEXT_NOTE + "\n\n" + context)
        await gemini.send_text(question)
        await asyncio.wait_for(done.wait(), ANSWER_TIMEOUT_S)
    finally:
        receiver.cancel()
        await gemini.close()
    return "".join(parts).strip()


async def run(args) -> int:
    cases = json.loads(CASES_PATH.read_text())
    if args.case:
        cases = [c for c in cases if c["id"] in args.case]
        if not cases:
            print(f"no case matches {args.case}", file=sys.stderr)
            return 2

    try:
        docs = await list_active_documents()
    except Exception as e:
        print(f"could not load the active documents: {type(e).__name__}: {e}; no verdict")
        return 2
    if args.check_sources:
        chunks = {
            d["name"]: [c["content"] for c in await list_document_chunks(d["id"])]
            for d in docs
        }
        problems = stale_sources(cases, chunks)
        for p in problems:
            print(f"[STALE] {p}")
        cited = sum(1 for c in cases if c.get("source"))
        print(f"{cited - len(problems)}/{cited} cited sources found in the active documents")
        return 1 if problems else 0

    try:
        knowledge = await build_knowledge_context([d["id"] for d in docs])
    except Exception as e:
        print(f"could not load the knowledge preload: {type(e).__name__}: {e}; no verdict")
        return 2
    system_prompt = build_system_prompt(knowledge)
    print(f"{len(docs)} active documents, {len(knowledge)} chars of preloaded knowledge\n")

    results = []
    for case in cases:
        for attempt in range(1, args.repeat + 1):
            answer, error = "", None
            # An infrastructure error says nothing about Manglara's answer, so
            # it is retried once and then kept apart from content failures.
            for _ in range(2):
                try:
                    answer, error = await ask(system_prompt, docs, case["question"]), None
                    break
                except Exception as e:
                    error = f"{type(e).__name__}: {e}"
            failures = [] if error else score(case, answer)
            status = "ERROR" if error else "FAIL" if failures else "PASS"
            print(f"[{status}] {case['id']} #{attempt}")
            for f in [error] if error else failures:
                print(f"    - {f}")
            if failures:
                print(f"    answer: {answer[:300]!r}")
            results.append(
                {
                    "id": case["id"],
                    "attempt": attempt,
                    "status": status,
                    "answer": answer,
                    "failures": failures,
                    "error": error,
                }
            )

    if args.out:
        Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=2))
    scored = [r for r in results if r["status"] != "ERROR"]
    errors = len(results) - len(scored)
    if errors:
        print(f"\n{errors}/{len(results)} sessions could not run; no verdict")
        return 2
    passed = sum(1 for r in scored if r["status"] == "PASS")
    rate = passed / len(scored)
    print(f"\n{passed}/{len(scored)} passed ({rate:.0%}); required {args.min_pass:.0%}")
    return 0 if rate >= args.min_pass else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--repeat", type=int, default=1, help="runs per case (answers vary)")
    parser.add_argument("--case", action="append", help="only this case id (repeatable)")
    parser.add_argument("--min-pass", type=float, default=1.0, help="required pass rate, 0-1")
    parser.add_argument(
        "--check-sources",
        action="store_true",
        help="only check that cited quotes still exist in the active documents (no Live calls)",
    )
    parser.add_argument("--out", help="write every answer and failure as JSON here")
    args = parser.parse_args()
    logging.basicConfig(level=logging.WARNING)
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
