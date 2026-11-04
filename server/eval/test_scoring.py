"""Tests de eval/scoring.py. Sin red: `python -m eval.test_scoring`."""

import json
import re
from pathlib import Path

from eval.scoring import normalize, score


def test_normalize_strips_accents_and_case():
    assert normalize("  Tiene CINCO   módulos ") == "tiene cinco modulos"


def test_include_any_passes_with_one_match():
    assert score({"include_any": ["\\b5\\b", "cinco"]}, "Son cinco módulos.") == []


def test_include_all_reports_each_missing_pattern():
    failures = score({"include_all": ["plan", "cinop"]}, "Lo hizo Plan.")
    assert failures == ["missing 'cinop'"], failures


def test_exclude_catches_invented_data():
    failures = score({"exclude": ["@"]}, "Escribe a info@fci.org")
    assert failures == ["forbidden '@'"], failures


def test_refusal_requires_admitting_missing_fact():
    case = {"refusal": True}
    assert score(case, "Esa información no la tengo a la mano.") == []
    assert score(case, "La meta 13.2 dice que...") == [
        "expected to say she does not have the fact"
    ]


def test_empty_answer_fails():
    assert score({"include_any": ["cinco"]}, "   ") == ["empty answer"]


def test_cases_file_is_valid():
    cases = json.loads(Path(__file__).with_name("cases.json").read_text())
    ids = [c["id"] for c in cases]
    assert len(ids) == len(set(ids)), "duplicate case id"
    for c in cases:
        assert c["question"].strip(), c["id"]
        assert any(k in c for k in ("include_any", "include_all", "refusal")), c["id"]
        for key in ("include_any", "include_all", "exclude"):
            for pattern in c.get(key, []):
                re.compile(pattern)
                assert pattern == normalize(pattern), f"{c['id']}: write {pattern!r} without accents"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
