"""Aggregate judged eval results into metrics, markdown and JSON.

Usage (from `server/`, no network):
    python -m eval.report judged.jsonl --out-md report.md --out-json report.json
    python -m eval.report candidate.jsonl --baseline baseline.jsonl --out-md cmp.md
"""

import argparse
import json
import unicodedata

from eval.dataset import CATEGORIES
from eval.judge import JUDGE_ERROR, NO_ANSWER, VERDICTS

SCALAR_METRICS = (
    "hallucination_rate",
    "correct_refusal_rate",
    "incorrect_refusal_rate",
    "supported_rate",
    "credits_completeness",
    "credits_fully_complete_rate",
    "language_compliance",
)


def _rate(num: int, den: int):
    return num / den if den else None


def _norm(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def _verdict(row: dict) -> str:
    return (row.get("judgment") or {}).get("verdict", JUDGE_ERROR)


def entity_coverage(row: dict):
    """Share of required entities named in the answer (any alias, accent-insensitive)."""
    entities = row.get("required_entities") or []
    if not entities:
        return None
    answer = _norm(row.get("answer", ""))
    hits = sum(any(_norm(alias) in answer for alias in aliases) for aliases in entities)
    return hits / len(entities)


def compute_metrics(rows: list[dict]) -> dict:
    judged = [r for r in rows if _verdict(r) in VERDICTS]
    by_cat: dict[str, list[dict]] = {}
    for r in judged:
        by_cat.setdefault(r["category"], []).append(r)

    def count(rs, verdict):
        return sum(_verdict(r) == verdict for r in rs)

    per_category = {}
    for cat in CATEGORIES:
        rs = by_cat.get(cat, [])
        per_category[cat] = {
            "n": len(rs),
            "hallucination_rate": _rate(count(rs, "hallucination"), len(rs)),
            "verdicts": {v: count(rs, v) for v in VERDICTS if count(rs, v)},
        }

    answerable = by_cat.get("answerable", [])
    unanswerable = by_cat.get("unanswerable", [])
    coverages = [c for c in (entity_coverage(r) for r in rows if r.get("category") == "credits"
                             and _verdict(r) != NO_ANSWER) if c is not None]
    lang = [r["judgment"]["language_ok"] for r in judged
            if isinstance(r["judgment"].get("language_ok"), bool)]
    return {
        "total": len(rows),
        "judged": len(judged),
        "judge_errors": sum(_verdict(r) == JUDGE_ERROR for r in rows),
        "no_answer": sum(_verdict(r) == NO_ANSWER for r in rows),
        "run_errors": sum(bool(r.get("error")) for r in rows),
        "timeouts": sum(bool(r.get("timed_out")) for r in rows),
        "hallucination_rate": _rate(count(judged, "hallucination"), len(judged)),
        "correct_refusal_rate": _rate(count(unanswerable, "correct_refusal"), len(unanswerable)),
        "incorrect_refusal_rate": _rate(count(answerable, "incorrect_refusal"), len(answerable)),
        "supported_rate": _rate(count(answerable, "supported"), len(answerable)),
        "credits_completeness": sum(coverages) / len(coverages) if coverages else None,
        "credits_fully_complete_rate": _rate(sum(c == 1 for c in coverages), len(coverages)),
        "language_compliance": _rate(sum(lang), len(lang)),
        "per_category": per_category,
    }


def _delta(a, b):
    return None if a is None or b is None else b - a


def compare(baseline_rows: list[dict], candidate_rows: list[dict]) -> dict:
    base, cand = compute_metrics(baseline_rows), compute_metrics(candidate_rows)
    deltas = {k: _delta(base[k], cand[k]) for k in SCALAR_METRICS}
    deltas["per_category_hallucination_rate"] = {
        cat: _delta(base["per_category"][cat]["hallucination_rate"],
                    cand["per_category"][cat]["hallucination_rate"])
        for cat in CATEGORIES
    }
    base_by_id = {r["id"]: _verdict(r) for r in baseline_rows}
    changed = [
        {"id": r["id"], "baseline": base_by_id[r["id"]], "candidate": _verdict(r)}
        for r in candidate_rows
        if r["id"] in base_by_id and base_by_id[r["id"]] != _verdict(r)
    ]
    return {"baseline": base, "candidate": cand, "deltas": deltas, "changed": changed}


def _pct(v) -> str:
    return "n/a" if v is None else f"{v * 100:.1f}%"


def _signed_pct(v) -> str:
    return "n/a" if v is None else f"{v * 100:+.1f} pp"


_LABELS = {
    "hallucination_rate": "Hallucination rate (all judged)",
    "correct_refusal_rate": "Correct refusal rate (unanswerable)",
    "incorrect_refusal_rate": "Incorrect refusal rate (answerable)",
    "supported_rate": "Supported rate (answerable)",
    "credits_completeness": "Credits completeness (entities named)",
    "credits_fully_complete_rate": "Credits fully complete",
    "language_compliance": "Language compliance",
}


def render_markdown(m: dict, title: str = "Manglara hallucination eval") -> str:
    lines = [
        f"# {title}",
        "",
        f"Cases: {m['total']} · judged: {m['judged']} · judge errors: {m['judge_errors']} "
        f"· no answer: {m['no_answer']} · run errors: {m['run_errors']} "
        f"· timeouts: {m['timeouts']}",
        "",
        "| Metric | Value |",
        "|---|---|",
    ]
    lines += [f"| {_LABELS[k]} | {_pct(m[k])} |" for k in SCALAR_METRICS]
    lines += ["", "## Per category", "", "| Category | n | Hallucination rate | Verdicts |",
              "|---|---|---|---|"]
    for cat, c in m["per_category"].items():
        verdicts = ", ".join(f"{v}: {n}" for v, n in c["verdicts"].items()) or "-"
        lines.append(f"| {cat} | {c['n']} | {_pct(c['hallucination_rate'])} | {verdicts} |")
    return "\n".join(lines) + "\n"


def render_comparison_markdown(cmp: dict) -> str:
    base, cand, d = cmp["baseline"], cmp["candidate"], cmp["deltas"]
    lines = ["# Manglara hallucination eval — baseline vs candidate", "",
             "| Metric | Baseline | Candidate | Δ |", "|---|---|---|---|"]
    lines += [f"| {_LABELS[k]} | {_pct(base[k])} | {_pct(cand[k])} | {_signed_pct(d[k])} |"
              for k in SCALAR_METRICS]
    lines += ["", "## Hallucination rate per category", "",
              "| Category | Baseline | Candidate | Δ |", "|---|---|---|---|"]
    for cat in CATEGORIES:
        lines.append(
            f"| {cat} | {_pct(base['per_category'][cat]['hallucination_rate'])} "
            f"| {_pct(cand['per_category'][cat]['hallucination_rate'])} "
            f"| {_signed_pct(d['per_category_hallucination_rate'][cat])} |"
        )
    lines += ["", "## Verdict changes", ""]
    lines += [f"- {c['id']}: {c['baseline']} → {c['candidate']}" for c in cmp["changed"]] or [
        "- none"]
    return "\n".join(lines) + "\n"


def _read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def main(argv=None):
    p = argparse.ArgumentParser(description="Hallucination eval report.")
    p.add_argument("judged", help="judged results (candidate when --baseline is given)")
    p.add_argument("--baseline", help="judged results of the baseline run to compare against")
    p.add_argument("--out-md", help="write the markdown report here")
    p.add_argument("--out-json", help="write the metrics JSON here")
    args = p.parse_args(argv)

    rows = _read_jsonl(args.judged)
    payload = {"metrics": compute_metrics(rows)}
    md = render_markdown(payload["metrics"])
    if args.baseline:
        cmp = compare(_read_jsonl(args.baseline), rows)
        payload["comparison"] = cmp
        md += "\n" + render_comparison_markdown(cmp)

    if args.out_md:
        with open(args.out_md, "w", encoding="utf-8") as f:
            f.write(md)
    if args.out_json:
        with open(args.out_json, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    print(md)


if __name__ == "__main__":
    main()
