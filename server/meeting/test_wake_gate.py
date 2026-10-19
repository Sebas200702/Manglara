"""Pruebas sin red del filtro local de activación."""

import json

from meeting.wake_gate import BYTES_PER_SECOND, WakeGate, _has_name


class Recognizer:
    def __init__(self):
        self.text = ""
        self.resets = 0

    def AcceptWaveform(self, pcm):
        self.text = "Manglara" if pcm == b"WAKE" else "otra conversación"
        return False

    def PartialResult(self):
        return json.dumps({"partial": self.text})

    def Reset(self):
        self.resets += 1


def main():
    assert _has_name("¡Mánglara, ayúdame!", "Manglara")
    assert _has_name("manglar", "Manglara")
    assert not _has_name("manglaras", "Manglara")
    recognizer = Recognizer()
    gate = WakeGate(recognizer, "Manglara")
    quiet = b"\0" * (BYTES_PER_SECOND // 10)
    speech = b"\xff\x3f" * (BYTES_PER_SECOND // 20)
    for _ in range(40):
        assert gate.feed(quiet) == []
    assert gate.feed(b"WAKE")[-1].endswith(b"WAKE")
    assert gate.feed(speech) == [speech]
    for _ in range(12):
        gate.feed(quiet)
    assert recognizer.resets == 1
    assert gate.feed(speech) == []
    assert gate.feed(b"WAKE")[-1].endswith(b"WAKE")
    gate.reset()
    assert gate.feed(speech) == []
    print("wake gate OK")


if __name__ == "__main__":
    main()
