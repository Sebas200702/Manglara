"""Eval cases: loading and schema validation of `dataset.jsonl`."""

import json
import os

DATASET_PATH = os.path.join(os.path.dirname(__file__), "dataset.jsonl")

CATEGORIES = ("answerable", "unanswerable", "false_premise", "credits", "off_topic")
REQUIRED_FIELDS = ("id", "category", "question", "expected_facts", "must_not", "notes")
LANGS = ("es", "en", "fr", "pt")
SOURCE_FIELDS = ("document", "page", "quote")


def load_dataset(path: str = DATASET_PATH) -> list[dict]:
    cases = []
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                cases.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{line_no}: invalid JSON: {e}") from e
    return cases


def validate_cases(cases: list[dict]) -> list[str]:
    """Return one message per schema problem; empty means valid."""
    errors: list[str] = []
    seen: set[str] = set()
    for i, case in enumerate(cases):
        label = f"case {i} ({case.get('id', '?')})"
        missing = [f for f in REQUIRED_FIELDS if f not in case]
        if missing:
            errors.append(f"{label}: missing field(s) {', '.join(missing)}")
            continue
        if case["id"] in seen:
            errors.append(f"{label}: duplicate id")
        seen.add(case["id"])
        if case["category"] not in CATEGORIES:
            errors.append(f"{label}: unknown category '{case['category']}'")
        if not str(case["question"]).strip():
            errors.append(f"{label}: empty question")
        for field in ("expected_facts", "must_not"):
            if not isinstance(case[field], list) or not all(
                isinstance(x, str) for x in case[field]
            ):
                errors.append(f"{label}: {field} must be a list of strings")
        if case["category"] in ("answerable", "false_premise", "credits") and not case[
            "expected_facts"
        ]:
            errors.append(f"{label}: expected_facts required for {case['category']}")
        if case.get("lang", "es") not in LANGS:
            errors.append(f"{label}: lang must be one of {LANGS}")
        if case["category"] == "credits":
            ents = case.get("required_entities")
            if not ents or not all(
                isinstance(e, list) and e and all(isinstance(a, str) for a in e)
                for e in ents
            ):
                errors.append(f"{label}: credits needs required_entities (alias lists)")
        if "source" in case:
            errors += [f"{label}: {e}" for e in _source_errors(case["source"])]
    return errors


def _source_errors(source) -> list[str]:
    """Optional `source`: the cartilla passage a case was written from."""
    if not isinstance(source, dict):
        return ["source must be an object with document, page and quote"]
    missing = [f for f in SOURCE_FIELDS if f not in source]
    if missing:
        return [f"source missing {', '.join(missing)}"]
    errors = []
    for field in ("document", "quote"):
        if not isinstance(source[field], str) or not source[field].strip():
            errors.append(f"source {field} must be a non-empty string")
    if not isinstance(source["page"], int) or isinstance(source["page"], bool):
        errors.append("source page must be an int")
    return errors


def select_cases(cases: list[dict], ids: list[str] | None, limit: int | None) -> list[dict]:
    if ids:
        wanted = set(ids)
        unknown = wanted - {c["id"] for c in cases}
        if unknown:
            raise ValueError(f"unknown case id(s): {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c["id"] in wanted]
    if limit is not None:
        cases = cases[:limit]
    return cases
