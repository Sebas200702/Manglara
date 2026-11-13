"""Admission control for the public voice WebSocket (/ws/voice).

Each voice session opens its own Gemini Live session, so every accepted socket
spends API quota. This module decides, before any Gemini work, whether a new
connection may start: allowed browser origin, a global cap and a per-IP cap.
Every limit is off when its setting is empty/0, so the default behavior is
unchanged.

State lives in process memory, so every cap is per worker: with
WEB_CONCURRENCY=N the instance admits up to N times VOICE_MAX_SESSIONS. Size
the caps per worker (see process_layout.py for the worker rules).
"""

import time
from collections import Counter, deque
from typing import Callable

BUSY_MESSAGE = "Manglara está atendiendo a muchas personas. Intenta de nuevo en un momento."
ORIGIN_MESSAGE = "Origen no permitido"


class VoiceAdmission:
    def __init__(
        self,
        max_sessions: int = 0,
        max_per_ip: int = 0,
        allowed_origins: list[str] | None = None,
        max_new_per_min: int = 0,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.max_sessions = max_sessions
        self.max_per_ip = max_per_ip
        self.allowed_origins = {o.rstrip("/") for o in (allowed_origins or [])}
        self.max_new_per_min = max_new_per_min
        self._clock = clock
        self._recent_starts: deque[float] = deque()
        self.active = 0
        self._per_ip: Counter[str] = Counter()

    def origin_allowed(self, origin: str | None) -> bool:
        if not self.allowed_origins:
            return True
        return bool(origin) and origin.rstrip("/") in self.allowed_origins

    def try_acquire(self, ip: str) -> str | None:
        """Reserve a slot for `ip`. Returns None when admitted, else the
        user-facing reason. Callers must `release(ip)` once admitted."""
        if self.max_sessions and self.active >= self.max_sessions:
            return BUSY_MESSAGE
        if self.max_per_ip and self._per_ip[ip] >= self.max_per_ip:
            return BUSY_MESSAGE
        if self.max_new_per_min:
            now = self._clock()
            while self._recent_starts and now - self._recent_starts[0] >= 60:
                self._recent_starts.popleft()
            if len(self._recent_starts) >= self.max_new_per_min:
                return BUSY_MESSAGE
            self._recent_starts.append(now)
        self.active += 1
        self._per_ip[ip] += 1
        return None

    def release(self, ip: str) -> None:
        self.active = max(0, self.active - 1)
        self._per_ip[ip] -= 1
        if self._per_ip[ip] <= 0:
            del self._per_ip[ip]
