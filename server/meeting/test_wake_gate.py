"""Pruebas sin red del filtro de activación."""

from meeting.wake_gate import BYTES_PER_SECOND, SILENCE_SECONDS, WakeGate, wake_words


def main():
    assert wake_words("Mánglara") == ["manglara"]
    gate = WakeGate()
    quiet = b"\0" * (BYTES_PER_SECOND // 10)
    speech = b"\xff\x3f" * (BYTES_PER_SECOND // 20)
    for _ in range(40):
        assert gate.feed(quiet) == ([], False)
    assert gate.feed(speech) == ([], False)
    buffered = gate.wake()
    assert buffered.endswith(speech), "el preaudio incluye lo último oído"
    assert gate.wake() == b"", "un segundo aviso no repite el preaudio"
    assert gate.feed(speech) == ([speech], False)
    closed = False
    for _ in range(int(SILENCE_SECONDS * 10)):
        _, closed = gate.feed(quiet)
    assert closed, "una pausa cierra el paso"
    assert gate.feed(speech) == ([], False)
    gate.wake()
    gate.reset()
    assert gate.feed(speech) == ([], False)
    print("wake gate OK")


if __name__ == "__main__":
    main()
