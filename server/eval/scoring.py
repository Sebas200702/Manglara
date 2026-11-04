"""Deterministic checks for one eval answer. Patterns are regexes matched
against the normalized answer (lowercase, no accents), so cases are written
without tildes: 'modulos', not 'módulos'.
"""

import re
import unicodedata

# Ways Manglara says she does not have a fact. Matching one is what a
# "refusal" case expects instead of an invented answer.
REFUSAL_PATTERNS = [
    r"no (la |lo |los |las )?tengo",
    r"no cuento con",
    r"no dispongo",
    r"equipo de (la )?(fci|fundacion)",
    r"(don't|do not) have",
    r"fci team",
]


def normalize(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.lower())
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", stripped).strip()


def score(case: dict, answer: str) -> list[str]:
    """Return the failed checks; an empty list means the case passed."""
    text = normalize(answer)
    failures: list[str] = []
    if not text:
        return ["empty answer"]
    for pattern in case.get("include_all", []):
        if not re.search(pattern, text):
            failures.append(f"missing {pattern!r}")
    any_of = case.get("include_any", [])
    if any_of and not any(re.search(p, text) for p in any_of):
        failures.append(f"missing one of {any_of!r}")
    for pattern in case.get("exclude", []):
        if re.search(pattern, text):
            failures.append(f"forbidden {pattern!r}")
    if case.get("refusal") and not any(re.search(p, text) for p in REFUSAL_PATTERNS):
        failures.append("expected to say she does not have the fact")
    return failures
