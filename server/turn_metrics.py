"""Per-turn timing of the voice chat: did the cartilla context reach Gemini
before Manglara started answering?

Context that lands after the answer starts only helps the next turn, so that
turn was answered from the model's own memory: the main hallucination risk.
"""

import time
from typing import Callable


class TurnMetrics:
    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self.turn = 0
        self.turns_with_context = 0
        self.late_context_turns = 0
        self.no_context_turns = 0
        self._reset()

    def _reset(self):
        self._speech_start: float | None = None
        self._context_at: float | None = None
        self._answer_at: float | None = None
        self._rag_ms: float | None = None
        self._late = False

    def _ms(self, start: float | None, end: float | None) -> int | None:
        if start is None or end is None:
            return None
        return round((end - start) * 1000)

    def speech_started(self):
        if self._speech_start is None:
            self._speech_start = self._clock()

    def context_injected(self, rag_ms: float, turn: int | None = None):
        # Only the first injection of the turn counts: it is the one that could
        # have reached the model before the answer. A retrieval that outlived
        # its turn (turn != self.turn) must not be credited to the next one.
        if turn is not None and turn != self.turn:
            return
        if self._context_at is None:
            self._context_at = self._clock()
            self._rag_ms = rag_ms

    def retrieval_late(self):
        """Retrieval only started after the answer: this turn had no context."""
        self._late = True

    def answer_started(self):
        if self._answer_at is None:
            self._answer_at = self._clock()

    def finish(self) -> dict | None:
        """Close the turn and return its record, or None if the visitor did not
        speak (Manglara's greeting is not a question to ground)."""
        if self._speech_start is None:
            self._reset()
            return None
        self.turn += 1
        if self._late or (
            self._context_at is not None
            and self._answer_at is not None
            and self._context_at > self._answer_at
        ):
            context = "late"
            self.late_context_turns += 1
        elif self._context_at is None:
            context = "none"
            self.no_context_turns += 1
        else:
            context = "before_answer"
            self.turns_with_context += 1
        record = {
            "turn": self.turn,
            "context": context,
            "rag_ms": None if self._rag_ms is None else round(self._rag_ms),
            "speech_to_context_ms": self._ms(self._speech_start, self._context_at),
            "speech_to_answer_ms": self._ms(self._speech_start, self._answer_at),
        }
        self._reset()
        return record

    def summary(self) -> dict:
        return {
            "turns": self.turn,
            "context_before_answer": self.turns_with_context,
            "context_late": self.late_context_turns,
            "context_none": self.no_context_turns,
        }
