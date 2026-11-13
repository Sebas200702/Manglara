"""Offline tests of the hallucination eval harness.

Run without pytest or network, from `server/`: `python -m eval.test_eval`.
They need the required env of config.py (dummy values are enough). Gemini
Live sessions and the judge model are replaced by fakes.
"""

import asyncio
import contextlib
import io
import json
import os
import tempfile

from eval import dataset, judge, keyguard, report, session

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


# --- dataset -----------------------------------------------------------------


def test_dataset():
    print("dataset")
    cases = dataset.load_dataset()
    check(len(cases) >= 40, f"dataset has >= 40 cases ({len(cases)})")
    check(dataset.validate_cases(cases) == [], "every case matches the schema")
    ids = [c["id"] for c in cases]
    check(len(ids) == len(set(ids)), "case ids are unique")
    cats = {c["category"] for c in cases}
    check(cats == set(dataset.CATEGORIES), "every category is covered")
    check(sum(c.get("lang") == "en" for c in cases) >= 4, "at least 4 English cases")
    credits = [c for c in cases if c["category"] == "credits"]
    check(all(c.get("required_entities") for c in credits),
          "credits cases list the required entities")

    bad = [
        {"id": "x", "category": "nope", "question": "q", "expected_facts": [],
         "must_not": [], "notes": ""},
        {"id": "x", "category": "answerable", "question": "", "expected_facts": [],
         "must_not": [], "notes": ""},
        {"id": "y", "category": "answerable", "question": "q"},
    ]
    errors = dataset.validate_cases(bad)
    check(any("unknown category" in e for e in errors), "unknown category is rejected")
    check(any("duplicate id" in e for e in errors), "duplicate id is rejected")
    check(any("empty question" in e for e in errors), "empty question is rejected")
    check(any("missing field" in e for e in errors), "missing field is rejected")
    check(any("expected_facts" in e for e in errors),
          "answerable case without expected facts is rejected")


# --- key guard ---------------------------------------------------------------


def test_keyguard():
    print("key guard")
    try:
        keyguard.resolve_eval_key({"GEMINI_API_KEY": "prod"}, env_files=[])
        check(False, "missing EVAL key refuses")
    except keyguard.EvalKeyError as e:
        check("EVAL_GEMINI_API_KEY" in str(e), "missing EVAL key refuses with a clear message")

    try:
        keyguard.resolve_eval_key(
            {"GEMINI_API_KEY": "prod", "EVAL_GEMINI_API_KEY": " prod "}, env_files=[]
        )
        check(False, "EVAL key equal to GEMINI_API_KEY refuses")
    except keyguard.EvalKeyError as e:
        check("production" in str(e), "EVAL key equal to GEMINI_API_KEY refuses")

    with tempfile.TemporaryDirectory() as tmp:
        env_file = os.path.join(tmp, ".env")
        with open(env_file, "w") as f:
            f.write("GEMINI_API_KEY=prod-from-dotenv\n")
        try:
            keyguard.resolve_eval_key(
                {"EVAL_GEMINI_API_KEY": "prod-from-dotenv"}, env_files=[env_file]
            )
            check(False, "EVAL key equal to the .env production key refuses")
        except keyguard.EvalKeyError:
            check(True, "EVAL key equal to the .env production key refuses")

    key = keyguard.resolve_eval_key(
        {"GEMINI_API_KEY": "prod", "EVAL_GEMINI_API_KEY": "test-key"}, env_files=[]
    )
    check(key == "test-key", "a distinct EVAL key is accepted")

    import hashlib

    with tempfile.TemporaryDirectory() as tmp:
        env_file = os.path.join(tmp, ".env")
        with open(env_file, "w") as f:
            f.write("GEMINI_API_KEY=old-local-key\n")
        prod_hash = hashlib.sha256(b"real-prod").hexdigest()
        key = keyguard.resolve_eval_key(
            {"EVAL_GEMINI_API_KEY": "old-local-key", "PRODUCTION_GEMINI_KEY_SHA256": prod_hash},
            env_files=[env_file],
        )
        check(key == "old-local-key", "with a production hash, the local .env key is usable")
        try:
            keyguard.resolve_eval_key(
                {"EVAL_GEMINI_API_KEY": "real-prod", "PRODUCTION_GEMINI_KEY_SHA256": prod_hash.upper()},
                env_files=[env_file],
            )
            check(False, "EVAL key matching the production hash refuses")
        except keyguard.EvalKeyError:
            check(True, "EVAL key matching the production hash refuses")

    import config
    import gemini_client

    saved_env = os.environ.get("GEMINI_API_KEY")
    saved_cfg, saved_gc = config.GEMINI_API_KEY, gemini_client.GEMINI_API_KEY
    try:
        keyguard.apply_eval_key("test-key")
        check(os.environ["GEMINI_API_KEY"] == "test-key", "apply_eval_key overrides the env")
        check(config.GEMINI_API_KEY == "test-key", "apply_eval_key patches config")
        check(gemini_client.GEMINI_API_KEY == "test-key",
              "apply_eval_key patches the Live client module")
    finally:
        if saved_env is None:
            os.environ.pop("GEMINI_API_KEY", None)
        else:
            os.environ["GEMINI_API_KEY"] = saved_env
        config.GEMINI_API_KEY, gemini_client.GEMINI_API_KEY = saved_cfg, saved_gc


# --- session collection ------------------------------------------------------


class FakeLive:
    """Mimics GeminiLiveClient: callbacks fire from receive_loop."""

    def __init__(self, chunks=("Hola, ", "soy Manglara."), complete=True,
                 fail_on_send=False, fail_in_loop=False):
        self.chunks = chunks
        self.complete = complete
        self.fail_on_send = fail_on_send
        self.fail_in_loop = fail_in_loop
        self.transcript_callback = None
        self.turn_complete_callback = None
        self.system_prompt = None
        self.injected = []
        self.sent = []
        self.closed = False
        self._asked = asyncio.Event()

    async def connect(self, system_prompt=None, extra_config=None):
        self.system_prompt = system_prompt

    async def inject_context(self, text):
        self.injected.append(text)

    async def send_text(self, text):
        if self.fail_on_send:
            raise RuntimeError("socket closed")
        self.sent.append(text)
        self._asked.set()

    async def receive_loop(self):
        await self._asked.wait()
        if self.fail_in_loop:
            raise RuntimeError("1011 exceeded your current quota")
        for c in self.chunks:
            await self.transcript_callback("user", "ignored")
            await self.transcript_callback("model", c)
            yield b"\x00\x00"
        if self.complete:
            await self.turn_complete_callback()
        await asyncio.Event().wait()  # an idle Live session never ends

    async def close(self):
        self.closed = True


def test_session():
    print("session")
    live = FakeLive()
    out = asyncio.run(session.ask(
        live, "SYS", ["NOTE A", "NOTE B"], "¿Cuántos módulos?", timeout_s=2, grace_s=0
    ))
    check(out["answer"] == "Hola, soy Manglara.", "collects the model transcript only")
    check(not out["timed_out"] and out["error"] is None, "completed turn is not an error")
    check(live.system_prompt == "SYS", "connects with the given system prompt")
    check(live.injected == ["NOTE A", "NOTE B"], "injects context notes before asking")
    check(live.sent == ["¿Cuántos módulos?"], "sends the question as a full text turn")
    check(live.closed, "closes the session after the turn")

    live = FakeLive(complete=False)
    out = asyncio.run(session.ask(live, "SYS", [], "q", timeout_s=0.2, grace_s=0))
    check(out["timed_out"], "missing turn_complete times out")
    check(out["answer"] == "Hola, soy Manglara.", "keeps the partial transcript on timeout")
    check(live.closed, "closes the session on timeout")

    live = FakeLive(fail_on_send=True)
    out = asyncio.run(session.ask(live, "SYS", [], "q", timeout_s=1, grace_s=0))
    check(out["error"] and "socket closed" in out["error"], "send failure is reported")
    check(live.closed, "closes the session on send error")

    live = FakeLive(fail_in_loop=True)
    out = asyncio.run(session.ask(live, "SYS", [], "q", timeout_s=1, grace_s=0))
    check(out["error"] and "quota" in out["error"], "receive-loop failure is reported")
    check(live.closed, "closes the session on receive error")


def test_run_case():
    print("run case")
    from prompt import CONTEXT_NOTE, LANGUAGE_REMINDER

    live = FakeLive()

    async def retrieve(doc_ids, text):
        assert doc_ids == ["d1"]
        return "[Página 3]\n5 módulos"

    case = {"id": "a01", "category": "answerable", "question": "¿Cuántos módulos?",
            "expected_facts": ["5 módulos"], "must_not": [], "notes": "", "lang": "es"}
    knowledge = session.Knowledge(doc_ids=["d1"], system_prompt="SYS+KB", preload_chars=6)
    row = asyncio.run(session.run_case(
        case, knowledge, retrieve, lambda: live, timeout_s=1, grace_s=0
    ))
    check(live.injected == [LANGUAGE_REMINDER, CONTEXT_NOTE + "\n\n[Página 3]\n5 módulos"],
          "injects the language reminder and the RAG note like production")
    check(row["retrieved_context"] == "[Página 3]\n5 módulos", "stores the retrieved context")
    check(row["id"] == "a01" and row["expected_facts"] == ["5 módulos"],
          "result row carries the case fields")
    check(row["answer"] == "Hola, soy Manglara.", "result row carries the answer")

    async def broken_retrieve(doc_ids, text):
        raise RuntimeError("supabase down")

    live = FakeLive()
    row = asyncio.run(session.run_case(
        case, knowledge, broken_retrieve, lambda: live, timeout_s=1, grace_s=0
    ))
    check(row["retrieval_error"] == "supabase down" and live.injected == [LANGUAGE_REMINDER],
          "retrieval failure is recorded and the case still runs")


def test_runner():
    print("runner")
    from eval import runner

    cases = dataset.load_dataset()[:3]
    clients = []

    def make_client():
        clients.append(FakeLive(complete=len(clients) != 1))
        return clients[-1]

    async def retrieve(doc_ids, text):
        return ""

    knowledge = session.Knowledge(doc_ids=["d1"], system_prompt="SYS", preload_chars=0)
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "results.jsonl")
        rows = asyncio.run(runner.run_cases(cases, knowledge, retrieve, make_client, out,
                                            concurrency=1, delay_s=0, timeout_s=0.2))
        with open(out) as f:
            written = [json.loads(line) for line in f]
    check(len(rows) == 3 and len(written) == 3, "run_cases writes one row per case")
    check(all(c.closed for c in clients), "run_cases closes every session")
    check(sum(r["timed_out"] for r in written) == 1, "a timed-out case is recorded, not fatal")
    check(runner.system_prompt_path("out/results.jsonl") == "out/results.system_prompt.txt",
          "system prompt sidecar path")

    saved = os.environ.pop("EVAL_GEMINI_API_KEY", None)
    try:
        runner.main(["--limit", "1"])
        check(False, "runner refuses without EVAL_GEMINI_API_KEY")
    except SystemExit as e:
        check(e.code == 2, "runner refuses without EVAL_GEMINI_API_KEY (exit 2)")
    finally:
        if saved is not None:
            os.environ["EVAL_GEMINI_API_KEY"] = saved

    args = runner.build_parser().parse_args(["--limit", "2", "--delay-s", "10"])
    plan = runner.plan_text(cases[:2], args)
    check(cases[0]["id"] in plan and "40,000" in plan, "dry-run plan lists cases and token cost")


# --- judge -------------------------------------------------------------------


def test_judge_parse():
    print("judge parse")
    good = json.dumps({"verdict": "supported", "unsupported_claims": [],
                       "missing_facts": ["x"], "language_ok": True})
    v = judge.parse_verdict(good)
    check(v["verdict"] == "supported" and v["missing_facts"] == ["x"]
          and v["language_ok"] is True, "parses strict JSON")

    fenced = "```json\n" + good + "\n```"
    check(judge.parse_verdict(fenced)["verdict"] == "supported", "parses fenced JSON")

    chatty = "Here is my verdict: " + json.dumps({"verdict": "hallucination",
                                                 "unsupported_claims": "cuesta 10 USD"}) + " done"
    v = judge.parse_verdict(chatty)
    check(v["verdict"] == "hallucination", "extracts JSON embedded in prose")
    check(v["unsupported_claims"] == ["cuesta 10 USD"], "coerces a string claim to a list")
    check(v["language_ok"] is None, "missing language_ok stays unknown")

    for raw in ["not json", json.dumps({"verdict": "great"}), "", json.dumps([1])]:
        v = judge.parse_verdict(raw)
        check(v["verdict"] == judge.JUDGE_ERROR, f"invalid judge output -> judge_error ({raw[:15]!r})")


class FakeModels:
    def __init__(self, text):
        self.text = text
        self.calls = []

    async def generate_content(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})

        class R:
            pass

        r = R()
        r.text = self.text
        return r


class FakeGenai:
    def __init__(self, text):
        class Aio:
            pass

        self.aio = Aio()
        self.aio.models = FakeModels(text)


def test_judge_call():
    print("judge call")
    row = {"id": "u01", "category": "unanswerable", "question": "¿Cuánto cuesta?",
           "expected_facts": [], "must_not": ["un precio inventado"], "lang": "es",
           "answer": "Esa información no la tengo a la mano.",
           "retrieved_context": "[Página 1]\nnada", "error": None, "timed_out": False}
    client = FakeGenai(json.dumps({"verdict": "correct_refusal", "unsupported_claims": [],
                                   "missing_facts": [], "language_ok": True}))
    v = asyncio.run(judge.judge_row(client, "models/judge", row, "SYSTEM PROMPT KB"))
    call = client.aio.models.calls[0]
    check(v["verdict"] == "correct_refusal", "returns the parsed judge verdict")
    check(call["config"]["temperature"] == 0, "judge runs at temperature 0")
    check(call["config"]["response_mime_type"] == "application/json", "judge asks for JSON")
    check("SYSTEM PROMPT KB" in call["contents"] and "[Página 1]" in call["contents"],
          "judge prompt includes the preload and the retrieved context")
    check("un precio inventado" in call["contents"], "judge prompt includes must_not")

    empty = dict(row, answer="", timed_out=True)
    client = FakeGenai("{}")
    v = asyncio.run(judge.judge_row(client, "models/judge", empty, "KB"))
    check(v["verdict"] == judge.NO_ANSWER and not client.aio.models.calls,
          "empty answer is not sent to the judge")


# --- report ------------------------------------------------------------------


def _row(cid, cat, verdict, lang_ok=True, answer="", entities=None, missing=None):
    row = {"id": cid, "category": cat, "answer": answer,
           "judgment": {"verdict": verdict, "unsupported_claims": [],
                        "missing_facts": missing or [], "language_ok": lang_ok}}
    if entities:
        row["required_entities"] = entities
    return row


FIXTURE = [
    _row("a1", "answerable", "supported"),
    _row("a2", "answerable", "hallucination", lang_ok=False),
    _row("a3", "answerable", "incorrect_refusal"),
    _row("a4", "answerable", "partial"),
    _row("u1", "unanswerable", "correct_refusal"),
    _row("u2", "unanswerable", "hallucination"),
    _row("f1", "false_premise", "supported"),
    _row("c1", "credits", "supported",
         answer="Lo hicieron la Fundación Plan y CINOP, con Erasmus+.",
         entities=[["fundacion plan"], ["cinop"], ["txorierri"], ["erasmus"]]),
    _row("o1", "off_topic", "correct_refusal"),
    _row("x1", "answerable", judge.JUDGE_ERROR, lang_ok=None),
    _row("x2", "answerable", judge.NO_ANSWER, lang_ok=None),
]


def test_report():
    print("report")
    m = report.compute_metrics(FIXTURE)
    check(m["total"] == 11 and m["judged"] == 9, "counts total and judged rows")
    check(m["judge_errors"] == 1 and m["no_answer"] == 1, "counts judge errors and no answers")
    check(abs(m["hallucination_rate"] - 2 / 9) < 1e-9, "overall hallucination rate")
    check(m["per_category"]["answerable"]["n"] == 4, "per-category n excludes unjudged rows")
    check(m["per_category"]["answerable"]["hallucination_rate"] == 0.25,
          "per-category hallucination rate")
    check(m["per_category"]["unanswerable"]["hallucination_rate"] == 0.5,
          "unanswerable hallucination rate")
    check(m["correct_refusal_rate"] == 0.5, "correct refusal rate on unanswerable")
    check(m["incorrect_refusal_rate"] == 0.25, "incorrect refusal rate on answerable")
    check(m["credits_completeness"] == 0.75, "credits completeness from entity aliases")
    check(m["credits_fully_complete_rate"] == 0.0, "credits fully-complete rate")
    check(abs(m["language_compliance"] - 8 / 9) < 1e-9, "language compliance")

    empty = report.compute_metrics([])
    check(empty["hallucination_rate"] is None, "empty run has no rates instead of dividing by 0")

    md = report.render_markdown(m)
    check("Hallucination rate" in md and "answerable" in md, "markdown report renders")

    better = [dict(r) for r in FIXTURE]
    better[1] = _row("a2", "answerable", "supported")
    cmp = report.compare(FIXTURE, better)
    check(abs(cmp["deltas"]["hallucination_rate"] - (-1 / 9)) < 1e-9,
          "comparison reports the hallucination delta")
    check(cmp["changed"] == [{"id": "a2", "baseline": "hallucination",
                              "candidate": "supported"}],
          "comparison lists per-case verdict changes")
    check("Δ" in report.render_comparison_markdown(cmp), "comparison markdown renders")

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "judged.jsonl")
        with open(src, "w") as f:
            for r in FIXTURE:
                f.write(json.dumps(r) + "\n")
        md_path, json_path = os.path.join(tmp, "r.md"), os.path.join(tmp, "r.json")
        with contextlib.redirect_stdout(io.StringIO()):
            report.main([src, "--out-md", md_path, "--out-json", json_path,
                         "--baseline", src])
        with open(json_path) as f:
            written = json.load(f)
        check(written["comparison"]["deltas"]["hallucination_rate"] == 0,
              "CLI writes metrics and comparison JSON")
        check(os.path.getsize(md_path) > 0, "CLI writes the markdown report")


def main():
    test_dataset()
    test_keyguard()
    test_session()
    test_run_case()
    test_runner()
    test_judge_parse()
    test_judge_call()
    test_report()
    print(f"\n{_passed} checks OK")


if __name__ == "__main__":
    main()
