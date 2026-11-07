"""LLM-as-judge: grades each runner answer against the knowledge it had.

Usage (from `server/`, needs EVAL_GEMINI_API_KEY):
    python -m eval.judge results.jsonl --out judged.jsonl

The reference knowledge is the exact system prompt of the run (curated facts
+ preloaded digests, saved by the runner next to the results) plus the
context retrieved for that case.
"""

import argparse
import asyncio
import json
import re
import sys

VERDICTS = ("supported", "hallucination", "correct_refusal", "incorrect_refusal", "partial")
JUDGE_ERROR = "judge_error"
NO_ANSWER = "no_answer"
JUDGE_CONFIG = {"temperature": 0, "response_mime_type": "application/json"}

CATEGORY_GUIDE = {
    "answerable": "The knowledge contains the answer. Expected: answer with the expected facts.",
    "unanswerable": (
        "The knowledge does NOT contain the answer. Expected: say it does not have that "
        "information (no invented numbers, names, dates, prices or contacts)."
    ),
    "false_premise": (
        "The question embeds a false fact. Expected: correct or reject the premise using "
        "the knowledge; accepting the premise is a hallucination."
    ),
    "credits": (
        "The question is about who made, supports or funds the curriculum/project. "
        "Expected: name ALL the entities in expected_facts; list each missing one in "
        "missing_facts."
    ),
    "off_topic": (
        "The question is outside the assistant's scope. Expected: gently redirect to the "
        "curriculum without answering with facts that are not in the knowledge."
    ),
}

PROMPT_TEMPLATE = """You are a strict grader of a voice assistant's answer for hallucinations.

RULES
- Any factual claim in the ANSWER that is not supported by the REFERENCE KNOWLEDGE is a hallucination, even if it is true in the real world.
- Greetings, empathy, invitations to keep talking and generic pedagogy are not factual claims.
- For an unanswerable or off-topic question, saying it does not have that information (or redirecting) is "correct_refusal".
- Refusing or saying "I don't know" when the knowledge does contain the answer is "incorrect_refusal".
- "supported": every factual claim is supported and the expected behavior is met.
- "partial": no unsupported claims, but some expected facts are missing.
- "hallucination": at least one unsupported claim, or a false premise accepted.
- language_ok: true only if the ANSWER is in the same language as the QUESTION (expected: {lang}).

CASE
category: {category} — {guide}
expected_facts: {expected_facts}
must_not (behaviors that are wrong here): {must_not}

=== REFERENCE KNOWLEDGE (system prompt of the run) ===
{knowledge}

=== RETRIEVED CONTEXT FOR THIS QUESTION ===
{retrieved}

=== QUESTION ===
{question}

=== ANSWER (transcript of the spoken reply) ===
{answer}

Reply with ONLY this JSON object:
{{"verdict": "supported|hallucination|correct_refusal|incorrect_refusal|partial", "unsupported_claims": ["..."], "missing_facts": ["..."], "language_ok": true}}"""


def build_prompt(row: dict, knowledge: str) -> str:
    return PROMPT_TEMPLATE.format(
        lang=row.get("lang", "es"),
        category=row["category"],
        guide=CATEGORY_GUIDE.get(row["category"], ""),
        expected_facts=json.dumps(row.get("expected_facts", []), ensure_ascii=False),
        must_not=json.dumps(row.get("must_not", []), ensure_ascii=False),
        knowledge=knowledge or "(none)",
        retrieved=row.get("retrieved_context") or "(none)",
        question=row["question"],
        answer=row.get("answer", ""),
    )


def _load_json(raw: str):
    text = (raw or "").strip()
    candidates = [text]
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        candidates.append(fence.group(1).strip())
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        candidates.append(text[start:end + 1])
    for c in candidates:
        try:
            return json.loads(c)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def _str_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    return [str(value)]


def parse_verdict(raw: str) -> dict:
    """Strict JSON first; fenced or embedded JSON as fallback; else judge_error."""
    data = _load_json(raw)
    if not isinstance(data, dict) or data.get("verdict") not in VERDICTS:
        return {"verdict": JUDGE_ERROR, "unsupported_claims": [], "missing_facts": [],
                "language_ok": None, "raw": (raw or "")[:2000]}
    lang_ok = data.get("language_ok")
    return {
        "verdict": data["verdict"],
        "unsupported_claims": _str_list(data.get("unsupported_claims")),
        "missing_facts": _str_list(data.get("missing_facts")),
        "language_ok": lang_ok if isinstance(lang_ok, bool) else None,
    }


async def judge_row(client, model: str, row: dict, knowledge: str) -> dict:
    if not (row.get("answer") or "").strip():
        return {"verdict": NO_ANSWER, "unsupported_claims": [], "missing_facts": [],
                "language_ok": None}
    try:
        resp = await client.aio.models.generate_content(
            model=model, contents=build_prompt(row, knowledge), config=dict(JUDGE_CONFIG)
        )
    except Exception as e:
        return {"verdict": JUDGE_ERROR, "unsupported_claims": [], "missing_facts": [],
                "language_ok": None, "raw": f"{type(e).__name__}: {e}"[:2000]}
    return parse_verdict(getattr(resp, "text", "") or "")


def _read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


async def _judge_file(args, key: str):
    from google import genai

    from eval.runner import system_prompt_path

    model = args.model
    if not model:
        from config import GEMINI_DIGEST_MODEL

        model = GEMINI_DIGEST_MODEL
    knowledge_path = args.system_prompt or system_prompt_path(args.results)
    with open(knowledge_path, encoding="utf-8") as f:
        knowledge = f.read()
    rows = _read_jsonl(args.results)
    client = genai.Client(api_key=key)
    with open(args.out, "w", encoding="utf-8") as out:
        for i, row in enumerate(rows):
            if i and args.delay_s:
                await asyncio.sleep(args.delay_s)
            row["judgment"] = await judge_row(client, model, row, knowledge)
            row["judge_model"] = model
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            print(f"[{i + 1}/{len(rows)}] {row['id']}: {row['judgment']['verdict']}")


def main(argv=None):
    p = argparse.ArgumentParser(description="Judge eval answers for hallucinations.")
    p.add_argument("results", help="runner output (results.jsonl)")
    p.add_argument("--out", required=True, help="judged output (judged.jsonl)")
    p.add_argument("--system-prompt", help="system prompt file of the run "
                   "(default: <results>.system_prompt.txt)")
    p.add_argument("--model", help="judge text model (default: GEMINI_DIGEST_MODEL)")
    p.add_argument("--delay-s", type=float, default=1.0, help="pause between judge calls")
    args = p.parse_args(argv)

    from eval.keyguard import EvalKeyError, apply_eval_key, resolve_eval_key

    try:
        key = resolve_eval_key()
    except EvalKeyError as e:
        print(e, file=sys.stderr)
        sys.exit(2)
    apply_eval_key(key)
    asyncio.run(_judge_file(args, key))


if __name__ == "__main__":
    main()
