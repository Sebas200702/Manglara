"""Ends voice sessions that stopped being used.

An open voice session keeps streaming microphone audio and camera frames to
Gemini Live, so a forgotten tab spends quota. The watchdog ends a session after
`idle_s` without activity, or after `max_s` in total. 0 disables either limit.
"""

import asyncio
import time
from typing import Callable

IDLE_MESSAGE = (
    "Cerré la conversación porque no escuché nada en un rato. "
    "Cuando quieras, vuelve a llamar a Manglara."
)
MAX_DURATION_MESSAGE = (
    "La conversación llegó a su tiempo máximo. Vuelve a llamar a Manglara para seguir."
)


class SessionWatchdog:
    def __init__(
        self,
        idle_s: float = 0,
        max_s: float = 0,
        clock: Callable[[], float] = time.monotonic,
        tick_s: float = 1.0,
    ):
        self.idle_s = idle_s
        self.max_s = max_s
        self._clock = clock
        self._tick_s = tick_s
        self._started = clock()
        self._last_activity = self._started

    def touch(self) -> None:
        """Record activity (the person spoke or Manglara finished a turn)."""
        self._last_activity = self._clock()

    def expired(self) -> str | None:
        now = self._clock()
        if self.max_s and now - self._started >= self.max_s:
            return MAX_DURATION_MESSAGE
        if self.idle_s and now - self._last_activity >= self.idle_s:
            return IDLE_MESSAGE
        return None

    async def wait(self) -> str:
        """Return the user-facing reason once the session should end."""
        if not self.idle_s and not self.max_s:
            await asyncio.Event().wait()
        while True:
            reason = self.expired()
            if reason:
                return reason
            await asyncio.sleep(self._tick_s)
