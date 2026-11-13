"""Run the eval cases against Gemini Live exactly like production does.

Usage (from `server/`):
    python -m eval.runner --dry-run --limit 3
    python -m eval.runner --check-sources   # cited quotes vs active docs, no Gemini
    EVAL_GEMINI_API_KEY=... python -m eval.runner --out results.jsonl

Each case opens one Live session (~20k tokens with the preloaded knowledge),
so sessions are serialized and spaced by --delay-s by default. The run is
refused unless EVAL_GEMINI_API_KEY is set and differs from the production
GEMINI_API_KEY; that key then replaces GEMINI_API_KEY for the whole process.
Supabase is only read (active documents, digests, chunk search).
"""

import argparse
import asyncio
import json
import os
import sys
import time

from eval import sources
from eval.dataset import load_dataset, select_cases, validate_cases
from eval.keyguard import EvalKeyError, apply_eval_key, resolve_eval_key

TOKENS_PER_CASE = 20_000


def system_prompt_path(results_path: str) -> str:
    stem = results_path[:-len(".jsonl")] if results_path.endswith(".jsonl") else results_path
    return stem + ".system_prompt.txt"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Hallucination eval runner (Gemini Live).")
    p.add_argument("--limit", type=int, help="run only the first N selected cases")
    p.add_argument("--ids", help="comma-separated case ids to run")
    p.add_argument("--concurrency", type=int, default=1, help="parallel sessions (default 1)")
    p.add_argument("--delay-s", type=float, default=10.0,
                   help="seconds between session starts, to respect quota (default 10)")
    p.add_argument("--timeout-s", type=float, default=45.0,
                   help="max seconds to wait for a turn to complete (default 45)")
    p.add_argument("--out", default="results.jsonl", help="output JSONL (default results.jsonl)")
    p.add_argument("--preload-chars", type=int,
                   help="override the preloaded knowledge budget for experiments")
    p.add_argument("--dry-run", action="store_true", help="print the plan; no network")
    p.add_argument("--check-sources", action="store_true",
                   help="only check that cited quotes still exist in the active documents "
                        "(reads Supabase, no Gemini); exit 1 if any is stale")
    return p


def plan_text(cases: list[dict], args) -> str:
    est_s = max(len(cases) - 1, 0) * args.delay_s / max(args.concurrency, 1)
    lines = [
        f"Eval plan: {len(cases)} case(s), concurrency={args.concurrency}, "
        f"delay={args.delay_s}s, timeout={args.timeout_s}s",
        f"Preload budget: {args.preload_chars if args.preload_chars else 'production default'}",
        f"Output: {args.out} (+ {system_prompt_path(args.out)})",
        f"Estimated cost: ~{len(cases) * TOKENS_PER_CASE:,} Live tokens; "
        f">= {est_s:.0f}s of pacing",
        "",
    ]
    lines += [f"  {c['id']:<6} {c['category']:<14} {c.get('lang', 'es')}  {c['question']}"
              for c in cases]
    return "\n".join(lines)


async def load_production_knowledge(preload_chars: int | None):
    """Same preload as main._voice_session, but failing loudly: an eval
    without knowledge would measure the wrong thing."""
    import config
    from db import list_active_documents
    from pdf import digest
    from prompt import build_system_prompt

    from eval.session import Knowledge

    if preload_chars is not None:
        # The budget may live in either module depending on the server version.
        for mod, name in ((digest, "MAX_KNOWLEDGE_CHARS"), (config, "VOICE_PRELOAD_CHARS")):
            if hasattr(mod, name):
                setattr(mod, name, preload_chars)
    active = await list_active_documents()
    doc_ids = [d["id"] for d in active]
    knowledge = await digest.build_knowledge_context(doc_ids)
    return Knowledge(doc_ids=doc_ids, system_prompt=build_system_prompt(knowledge),
                     preload_chars=len(knowledge))


async def run_cases(cases, knowledge, retrieve, make_client, out_path: str,
                    concurrency: int = 1, delay_s: float = 10.0,
                    timeout_s: float = 45.0) -> list[dict]:
    from eval.session import run_case

    sem = asyncio.Semaphore(max(concurrency, 1))
    pace = asyncio.Lock()
    last_start = [0.0]
    rows: list[dict] = []

    with open(out_path, "w", encoding="utf-8") as out:
        async def one(case):
            async with sem:
                async with pace:
                    wait = last_start[0] + delay_s - time.monotonic()
                    if last_start[0] and wait > 0:
                        await asyncio.sleep(wait)
                    last_start[0] = time.monotonic()
                row = await run_case(case, knowledge, retrieve, make_client,
                                     timeout_s=timeout_s)
                rows.append(row)
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                out.flush()
                status = row["error"] or ("timeout" if row["timed_out"] else "ok")
                print(f"[{len(rows)}/{len(cases)}] {case['id']}: {status} "
                      f"({row['duration_s']}s, {len(row['answer'])} chars)")

        await asyncio.gather(*(one(c) for c in cases))
    return rows


async def _run(args, cases, key: str):
    from gemini_client import GeminiLiveClient
    import gemini_client
    from pdf.retrieval import retrieve_context

    if gemini_client.GEMINI_API_KEY != key:
        raise SystemExit("Refusing to run: the Live client is not using EVAL_GEMINI_API_KEY.")

    knowledge = await load_production_knowledge(args.preload_chars)
    if not knowledge.doc_ids:
        raise SystemExit("No active documents: the eval needs the production knowledge.")
    with open(system_prompt_path(args.out), "w", encoding="utf-8") as f:
        f.write(knowledge.system_prompt)
    print(f"Preloaded {knowledge.preload_chars} chars from {len(knowledge.doc_ids)} document(s)")

    def make_client():
        client = GeminiLiveClient()
        client.log_transcripts = False
        return client

    rows = await run_cases(cases, knowledge, retrieve_context, make_client, args.out,
                           concurrency=args.concurrency, delay_s=args.delay_s,
                           timeout_s=args.timeout_s)
    failed = sum(bool(r["error"]) or r["timed_out"] for r in rows)
    print(f"Done: {len(rows)} case(s), {failed} failed/timed out -> {args.out}")


def main(argv=None):
    args = build_parser().parse_args(argv)
    cases = load_dataset()
    errors = validate_cases(cases)
    if errors:
        print("Invalid dataset:\n  " + "\n  ".join(errors), file=sys.stderr)
        sys.exit(2)
    ids = [i.strip() for i in args.ids.split(",") if i.strip()] if args.ids else None
    try:
        cases = select_cases(cases, ids, args.limit)
    except ValueError as e:
        print(e, file=sys.stderr)
        sys.exit(2)

    if args.check_sources:
        code, lines = asyncio.run(sources.check_active_sources(cases))
        print("\n".join(lines))
        sys.exit(code)

    if args.dry_run:
        print(plan_text(cases, args))
        try:
            resolve_eval_key()
            print("\nKey guard: EVAL_GEMINI_API_KEY is set and is not the production key.")
        except EvalKeyError as e:
            print(f"\nKey guard: {e}")
        return

    try:
        key = resolve_eval_key()
    except EvalKeyError as e:
        print(e, file=sys.stderr)
        sys.exit(2)
    # Before importing any server module, so every Gemini client gets this key.
    apply_eval_key(key)
    if args.preload_chars is not None:
        os.environ["VOICE_PRELOAD_CHARS"] = str(args.preload_chars)
    asyncio.run(_run(args, cases, key))


if __name__ == "__main__":
    main()
