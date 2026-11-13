# Hallucination eval

Measures how often Manglara's voice assistant states facts that are not in its
knowledge. Each case asks one question in a fresh Gemini Live session built
exactly like production `/ws/voice`:

- system prompt = `build_system_prompt(build_knowledge_context(active_ids))`
  (curated facts in `prompt.py` + digests of the active Supabase documents);
- before the question: `LANGUAGE_REMINDER` and `CONTEXT_NOTE + retrieve_context(...)`,
  the two notes production injects on a first turn;
- the question goes in as a text turn (`send_text`); the answer is the model's
  output transcription, collected until `turn_complete`.

A text model then judges each answer against the run's system prompt plus the
context retrieved for that question, and `report` aggregates the verdicts.

## Cost and quota warning

**Each case is one Live session of ~20k tokens.** The production key's Live
quota is tiny: around 8 sessions per minute exhausts it and takes the public
assistant down. That is why:

- the runner and the judge **refuse to run** unless `EVAL_GEMINI_API_KEY` is set
  and is not the production `GEMINI_API_KEY` (env or `.env`); that key then
  replaces `GEMINI_API_KEY` for the whole process;
- sessions run one at a time (`--concurrency 1`) with `--delay-s 10` between
  starts by default. The full dataset (142 cases) takes at least ~24 minutes and ~2.8M
  Live tokens: use `--ids` or `--limit` for focused runs.

Supabase is only read (active documents, digests, chunk search).

## Files

| File | Responsibility |
|---|---|
| `dataset.jsonl` | Cases: `id, category, question, expected_facts, must_not, notes, lang` (+ `required_entities` for credits, optional `source`) |
| `dataset.py` | Load, validate and select cases |
| `keyguard.py` | Refuse the production key; apply the eval key |
| `session.py` | One case = one Live session, transcript collection, always closes |
| `runner.py` | CLI: production knowledge, pacing, `results.jsonl`, `--check-sources` |
| `sources.py` | Verify cited quotes against the active documents (Supabase only) |
| `judge.py` | LLM-as-judge (temperature 0, strict JSON with fallback) |
| `report.py` | Metrics, markdown/JSON, baseline vs candidate deltas |
| `test_eval.py` | Offline tests with fakes (no network) |
| `test_sources.py` | Offline tests of the sources check (stubbed Supabase) |

Categories: `answerable` (fact in the cartillas or `SYSTEM_PROMPT`, quoted in
`notes`), `unanswerable` (plausible, not in the knowledge: must say it does not
have it), `false_premise` (must correct the premise), `credits` (must name every
entity of the REGLA DE CRÉDITOS), `off_topic` (must redirect). `lang` is `es`,
`en`, `fr` or `pt`; the non-Spanish cases check the language rule.

### Cited cases (`source`)

Cases written from an ingested cartilla carry
`"source": {"document": "<active document name>", "page": <int>, "quote": "<verbatim>"}`.
Before trusting a run, check that every quote still exists in the active
documents (a replaced or deactivated document silently turns its cases into
tests of nothing):

```bash
.venv/bin/python -m eval.runner --check-sources   # or with --ids a,b
```

It only reads Supabase (active documents and their chunks), never Gemini, and
needs no `EVAL_GEMINI_API_KEY`. Whitespace is ignored and the page is
informative only. Exit 0 = all found, 1 = some `[STALE]` (fix or drop those
cases), 2 = Supabase unavailable (no verdict).

### Origin of the cases

The first 57 cases were written for this harness. 85 more were ported from the
grounding eval of PR #14 (closed, superseded by this harness): 51 cartilla
cases with `source` and 34 prompt-fact cases, their regex checks rewritten as
`expected_facts`/`must_not` for the judge. Not ported: 30 cases that duplicate
an existing one and 7 whose expected facts contradict `server/prompt.py`
(curriculum and pathway durations from the *Resumen ejecutivo* — 24/11/9/8 h —
while the prompt states ~20 h total and the Introducción cartilla's
20,8/11,7/9,1/8,9 h). `server/prompt.py` is the source of truth: when it
changes, re-check those cases.

## Run

From `server/`:

```bash
# Offline tests (dummy env is enough)
GEMINI_API_KEY=x SUPABASE_URL=http://x SUPABASE_SERVICE_KEY=x .venv/bin/python -m eval.test_eval
GEMINI_API_KEY=x SUPABASE_URL=http://x SUPABASE_SERVICE_KEY=x .venv/bin/python -m eval.test_sources

# Plan only, no network
.venv/bin/python -m eval.runner --dry-run --limit 3

# 1. Ask (writes results.jsonl + results.system_prompt.txt)
EVAL_GEMINI_API_KEY=<test key> .venv/bin/python -m eval.runner --out runs/baseline.jsonl

# 2. Judge (default model: GEMINI_DIGEST_MODEL)
EVAL_GEMINI_API_KEY=<test key> .venv/bin/python -m eval.judge runs/baseline.jsonl --out runs/baseline.judged.jsonl

# 3. Report (no network)
.venv/bin/python -m eval.report runs/baseline.judged.jsonl --out-md runs/baseline.md --out-json runs/baseline.json
```

Runner options: `--limit N`, `--ids a01,u03`, `--concurrency 1`, `--delay-s 10`,
`--timeout-s 45`, `--out results.jsonl`, `--preload-chars N` (override the
preload budget for an experiment; check the printed "Preloaded N chars" line),
`--dry-run`, `--check-sources`. Results are written as each case finishes, so an interrupted run
keeps its rows.

## Compare runs

Run, judge and report the candidate (new prompt or config) the same way, then:

```bash
.venv/bin/python -m eval.report runs/candidate.judged.jsonl \
  --baseline runs/baseline.judged.jsonl --out-md runs/compare.md --out-json runs/compare.json
```

The comparison shows each metric for both runs with its delta in percentage
points, the per-category hallucination deltas and the cases whose verdict
changed. Example, preload budget experiment:

```bash
EVAL_GEMINI_API_KEY=<test key> .venv/bin/python -m eval.runner --preload-chars 12000 --out runs/preload12k.jsonl
```

## Metrics

- **Hallucination rate**: `hallucination` verdicts / judged answers, overall and per category.
- **Correct refusal rate**: `correct_refusal` / judged `unanswerable` cases.
- **Incorrect refusal rate** and **supported rate**: over judged `answerable` cases.
- **Credits completeness**: share of required entities named in credits answers
  (accent-insensitive alias match, deterministic); **fully complete** = all named.
- **Language compliance**: judge's `language_ok` over judged answers.

Rows without an answer (timeout or session error) count as `no_answer` and
unparseable judge output as `judge_error`; both are excluded from the rates and
reported as counts. Judge verdicts are an LLM's opinion: read the
`unsupported_claims` of each `hallucination` before acting on a number.
