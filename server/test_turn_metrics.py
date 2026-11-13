"""Tests of turn_metrics.py. No dependencies; from `server/`: `python -m test_turn_metrics`."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from turn_metrics import TurnMetrics  # noqa: E402


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def make():
    clock = Clock()
    return TurnMetrics(clock=clock), clock


def test_context_before_answer():
    m, clock = make()
    m.speech_started()
    clock.now = 0.4
    m.context_injected(250, m.turn)
    clock.now = 1.0
    m.answer_started()
    assert m.finish() == {
        "turn": 1,
        "context": "before_answer",
        "rag_ms": 250,
        "speech_to_context_ms": 400,
        "speech_to_answer_ms": 1000,
    }


def test_context_after_answer_is_late():
    m, clock = make()
    m.speech_started()
    clock.now = 1.0
    m.answer_started()
    clock.now = 1.5
    m.context_injected(900, m.turn)
    assert m.finish()["context"] == "late"
    assert m.summary()["context_late"] == 1


def test_retrieval_started_after_answer_is_late():
    m, _ = make()
    m.speech_started()
    m.answer_started()
    m.retrieval_late()
    assert m.finish()["context"] == "late"


def test_no_retrieval_is_none():
    m, _ = make()
    m.speech_started()
    m.answer_started()
    assert m.finish()["context"] == "none"


def test_greeting_without_speech_is_not_a_turn():
    m, _ = make()
    m.answer_started()
    assert m.finish() is None
    assert m.summary()["turns"] == 0
    m.speech_started()
    assert m.finish()["speech_to_answer_ms"] is None


def test_stale_retrieval_not_credited_to_next_turn():
    m, _ = make()
    m.speech_started()
    stale = m.turn
    m.answer_started()
    m.finish()
    m.speech_started()
    m.context_injected(100, stale)
    m.answer_started()
    assert m.finish()["context"] == "none"


def test_summary_counts_each_outcome():
    m, clock = make()
    m.speech_started()
    m.context_injected(10, m.turn)
    clock.now = 1.0
    m.answer_started()
    m.finish()
    m.speech_started()
    m.answer_started()
    m.finish()
    assert m.summary() == {
        "turns": 2,
        "context_before_answer": 1,
        "context_late": 0,
        "context_none": 1,
    }


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
