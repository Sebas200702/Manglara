"""Retiene voz y texto de un turno hasta recibir aprobación independiente."""
import base64
import time
from collections.abc import Awaitable, Callable


class PolicyStop(Exception):
    """Código público cerrado: descartar conversación, nunca reproducir borrador."""


class OutputGate:
    """Estado efímero por socket; ninguna respuesta parcial cruza al navegador."""

    def __init__(self, review: Callable[..., Awaitable[bool]], send: Callable[..., Awaitable[None]]):
        self.review = review
        self.send = send
        self.history = []
        self.playback_until = 0.0
        self.stopped = False
        self._reset()

    def _reset(self):
        self.question = ""
        self.answer = ""
        self.pcm = bytearray()
        self.started = 0.0
        self.output_started = False
        self.reviewing = False
        self.text_turn = False

    @property
    def accepts_input(self) -> bool:
        return not (self.stopped or self.text_turn or self.output_started or self.reviewing
                    or time.monotonic() < self.playback_until)

    def _stop(self, code):
        self.stopped = True
        self._reset()
        raise PolicyStop(code)

    def begin_text(self, text: str):
        if not self.accepts_input or self.question:
            self._stop("TURN_BUSY")
        if not text.strip() or len(text) > 4000:
            self._stop("TURN_LIMIT")
        self.question = text
        self.text_turn = True
        self.started = time.monotonic()

    async def transcript(self, role: str, text: str):
        if self.stopped:
            raise PolicyStop("RESPONSE_BLOCKED")
        if role == "user":
            # Texto ya queda vinculado antes del envío; no duplicar eco del proveedor.
            if self.text_turn:
                return
            if self.reviewing:
                self._stop("TURN_BUSY")
            self.question += text
            if len(self.question) > 4000:
                self._stop("TURN_LIMIT")
            self.started = self.started or time.monotonic()
            await self.send({"type": "transcript", "role": "user", "text": text})
        elif role == "model":
            await self._start_output()
            self.started = self.started or time.monotonic()
            self.answer += text
            if len(self.answer) > 6000:
                self._stop("TURN_LIMIT")
        else:
            self._stop("RESPONSE_BLOCKED")

    async def audio(self, chunk: bytes):
        if self.stopped:
            raise PolicyStop("RESPONSE_BLOCKED")
        await self._start_output()
        self.started = self.started or time.monotonic()
        if len(chunk) % 2 or len(self.pcm) + len(chunk) > 2_880_000:
            self._stop("TURN_LIMIT")
        self.pcm.extend(chunk)

    async def _start_output(self):
        if not self.output_started:
            self.output_started = True
            await self.send({"type": "response_pending"})

    async def complete(self):
        self.check_deadline()
        if not self.question.strip() or not self.answer.strip() or not self.pcm:
            self._stop("RESPONSE_BLOCKED")
        self.reviewing = True
        try:
            approved = await self.review(self.question, self.answer, self.history[-3:], bytes(self.pcm))
        except Exception:
            self._stop("REVIEW_UNAVAILABLE")
        self.check_deadline()
        if approved is not True or self.stopped:
            self._stop("RESPONSE_BLOCKED")
        # El texto que vio el revisor es exactamente el que recibe el alumno.
        await self.send({"type": "transcript", "role": "model", "text": self.answer})
        self.playback_until = time.monotonic() + len(self.pcm) / 48000
        for offset in range(0, len(self.pcm), 24000):
            data = base64.b64encode(self.pcm[offset:offset + 24000]).decode()
            await self.send({"type": "audio", "data": data})
        await self.send({"type": "turn_complete"})
        self.history = (self.history + [{"question": self.question, "answer": self.answer}])[-3:]
        self._reset()

    async def interrupt(self):
        if self.reviewing:
            self._stop("RESPONSE_BLOCKED")
        self._reset()
        await self.send({"type": "interrupted"})

    def check_deadline(self):
        if self.started and time.monotonic() - self.started > 75:
            self._stop("TURN_TIMEOUT")

    def close(self):
        self.stopped = True
        self.history.clear()
        self._reset()
