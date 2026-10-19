"""Filtro de audio para activar Gemini al oír el nombre del bot.

El reconocimiento del nombre ocurre en el navegador del bot (Web Speech API,
ver audio_bridge.js), que avisa con `wake()`. Aquí solo se guarda un poco de
audio previo y se decide qué bloques pasan a Gemini.
"""

from collections import deque
import re
import unicodedata


SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2
# El aviso del navegador llega con retraso (reconocimiento en la nube): el
# preaudio debe cubrir el nombre y el inicio de la pregunta.
PREROLL_SECONDS = 3.0
SILENCE_SECONDS = 1.2
MAX_UTTERANCE_SECONDS = 30
SPEECH_RMS_THRESHOLD = 350


def wake_words(name: str) -> list[str]:
    """Nombre normalizado (minúsculas, sin tildes) que busca el navegador."""
    plain = unicodedata.normalize("NFKD", name.casefold())
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    return [" ".join(re.findall(r"[a-z0-9]+", plain))]


def _is_speech(pcm: bytes) -> bool:
    # Muestreo ligero del PCM16 mono; basta para detectar el final de una frase.
    samples = memoryview(pcm[: len(pcm) & ~1]).cast("h")
    if not samples:
        return False
    selected = samples[::4]
    rms = (sum(int(s) * int(s) for s in selected) / len(selected)) ** 0.5
    return rms >= SPEECH_RMS_THRESHOLD


class WakeGate:
    def __init__(self):
        self._preroll: deque[bytes] = deque()
        self._preroll_bytes = 0
        self._open = False
        self._open_bytes = 0
        self._silence_bytes = 0

    @property
    def is_open(self) -> bool:
        return self._open

    def reset(self):
        self._preroll.clear()
        self._preroll_bytes = 0
        self._open = False
        self._open_bytes = 0
        self._silence_bytes = 0

    def wake(self) -> bytes:
        """Abre el paso. Devuelve el preaudio que aún no llegó a Gemini."""
        self._silence_bytes = 0
        if self._open:
            return b""
        self._open = True
        self._open_bytes = self._preroll_bytes
        buffered = b"".join(self._preroll)
        self._preroll.clear()
        self._preroll_bytes = 0
        return buffered

    def feed(self, pcm: bytes) -> tuple[list[bytes], bool]:
        """Devuelve (bloques para Gemini, si el paso se acaba de cerrar)."""
        if not pcm:
            return [], False

        if self._open:
            self._open_bytes += len(pcm)
            self._silence_bytes = 0 if _is_speech(pcm) else self._silence_bytes + len(pcm)
            if (self._silence_bytes >= SILENCE_SECONDS * BYTES_PER_SECOND
                    or self._open_bytes >= MAX_UTTERANCE_SECONDS * BYTES_PER_SECOND):
                self.reset()
                return [pcm], True
            return [pcm], False

        self._preroll.append(pcm)
        self._preroll_bytes += len(pcm)
        while self._preroll_bytes > PREROLL_SECONDS * BYTES_PER_SECOND:
            self._preroll_bytes -= len(self._preroll.popleft())
        return [], False
