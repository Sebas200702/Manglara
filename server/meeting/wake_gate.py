"""Filtro local de audio para activar Gemini al oír el nombre del bot."""

from collections import deque
import json
import re
import unicodedata


SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2
PREROLL_SECONDS = 1.5
SILENCE_SECONDS = 1.2
MAX_UTTERANCE_SECONDS = 30
SPEECH_RMS_THRESHOLD = 350


def _words(text: str) -> list[str]:
    plain = unicodedata.normalize("NFKD", text.casefold())
    plain = "".join(c for c in plain if not unicodedata.combining(c))
    return re.findall(r"[a-z0-9]+", plain)


def wake_variants(name: str) -> list[list[str]]:
    """Formas del nombre que cuentan como activación (listas de palabras)."""
    variants = [_words(name)]
    if _words(name) == ["manglara"]:
        # El modelo español Vosk 0.42 no tiene "manglara" en su vocabulario;
        # suele transcribir el nombre como la palabra disponible "manglar".
        variants.append(["manglar"])
    return variants


def _has_name(text: str, name: str) -> bool:
    words = _words(text)
    variants = wake_variants(name)
    return any(
        needle and any(
            words[i : i + len(needle)] == needle
            for i in range(len(words) - len(needle) + 1)
        )
        for needle in variants
    )


def _is_speech(pcm: bytes) -> bool:
    # Muestreo ligero del PCM16 mono; basta para detectar el final de una frase.
    samples = memoryview(pcm[: len(pcm) & ~1]).cast("h")
    if not samples:
        return False
    selected = samples[::4]
    rms = (sum(int(s) * int(s) for s in selected) / len(selected)) ** 0.5
    return rms >= SPEECH_RMS_THRESHOLD


class WakeGate:
    def __init__(self, recognizer, name: str):
        self.recognizer = recognizer
        self.name = name
        self._preroll: deque[bytes] = deque()
        self._preroll_bytes = 0
        self._open = False
        self._open_bytes = 0
        self._silence_bytes = 0

    def reset(self):
        self._preroll.clear()
        self._preroll_bytes = 0
        self._open = False
        self._open_bytes = 0
        self._silence_bytes = 0
        self.recognizer.Reset()

    def feed(self, pcm: bytes) -> list[bytes]:
        """Devuelve únicamente los bloques que pueden ir a Gemini."""
        if not pcm:
            return []
        complete = self.recognizer.AcceptWaveform(pcm)
        result = self.recognizer.Result() if complete else self.recognizer.PartialResult()
        heard = json.loads(result).get("text" if complete else "partial", "")

        if self._open:
            self._open_bytes += len(pcm)
            self._silence_bytes = 0 if _is_speech(pcm) else self._silence_bytes + len(pcm)
            if (self._silence_bytes >= SILENCE_SECONDS * BYTES_PER_SECOND
                    or self._open_bytes >= MAX_UTTERANCE_SECONDS * BYTES_PER_SECOND):
                self.reset()
            return [pcm]

        self._preroll.append(pcm)
        self._preroll_bytes += len(pcm)
        while self._preroll_bytes > PREROLL_SECONDS * BYTES_PER_SECOND:
            self._preroll_bytes -= len(self._preroll.popleft())
        if _has_name(heard, self.name):
            self._open = True
            self._open_bytes = self._preroll_bytes
            self._silence_bytes = 0
            buffered = b"".join(self._preroll)
            self._preroll.clear()
            self._preroll_bytes = 0
            return [buffered]
        return []
