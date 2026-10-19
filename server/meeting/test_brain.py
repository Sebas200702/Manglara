"""Tests del cerebro (Gemini on/off) dentro del bridge, con un Gemini falso.

Se corren sin pytest ni red, desde `server/`: `python -m meeting.test_brain`.
Necesitan las env obligatorias de config.py (basta con valores dummy).
"""

import asyncio

from meeting import brain as brain_mod
from meeting.bridge import MeetingBridge
from meeting.models import MeetingSession
from meeting.wake_gate import WakeGate

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


class FakeGemini:
    instances: list["FakeGemini"] = []

    def __init__(self):
        FakeGemini.instances.append(self)
        self.prompt = None
        self.texts: list[str] = []
        self.audio: list[bytes] = []
        self.closed = False
        self.out: asyncio.Queue = asyncio.Queue()
        self.transcript_callback = None
        self.turn_complete_callback = None
        self.interrupt_callback = None
        self.on_user_turn_complete = None

    async def connect(self, system_prompt=None):
        self.prompt = system_prompt

    async def send_text(self, text):
        self.texts.append(text)

    async def send_audio_pcm16_16k(self, pcm):
        self.audio.append(pcm)

    async def inject_context(self, text):
        pass

    async def close(self):
        self.closed = True
        await self.out.put(None)

    async def receive_loop(self):
        while True:
            item = await self.out.get()
            if item is None:
                return
            if isinstance(item, Exception):
                raise item
            yield item


class FakeRecognizer:
    def AcceptWaveform(self, pcm):
        self.heard = b"WAKE" in pcm
        return False

    def PartialResult(self):
        return '{"partial": "Manglara"}' if self.heard else '{"partial": "conversación"}'

    def Reset(self):
        self.heard = False


class FakeRecipe:
    selectors: dict = {}

    def __init__(self):
        self.mic_calls: list[bool] = []

    async def set_mic(self, page, enabled):
        self.mic_calls.append(enabled)

    async def set_cam(self, page, enabled):
        pass


async def _no_knowledge(self):
    return ""


async def main():
    brain_mod.GeminiLiveClient = FakeGemini
    brain_mod._new_wake_gate = lambda: WakeGate(FakeRecognizer(), "Manglara")
    brain_mod.MeetingBrain._load_knowledge = _no_knowledge
    brain_mod.RECONNECT_WINDOW_S = 0  # toda caída cuenta como "lenta" → reconecta

    session = MeetingSession(provider="zoom", url="https://zoom.us/j/1")
    recipe = FakeRecipe()
    bridge = MeetingBridge(session, recipe)
    bridge.browser.page = object()  # página "viva" para los clicks de receta
    bridge._page_ws = object()  # WS interno "conectado" (send capturado abajo)

    sent: list[dict] = []
    transcripts: list[tuple[str, str]] = []

    async def capture(msg):
        sent.append(msg)

    async def on_transcript(role, text):
        transcripts.append((role, text))

    bridge._send_control = capture
    bridge.on_transcript = on_transcript

    print("brain_start fuera de la reunión")
    try:
        await bridge.brain_start()
        check(False, "debía fallar")
    except ValueError:
        check(session.brain == "off", "rechaza si bridge != in_meeting")

    print("brain_start dentro de la reunión")
    session.bridge = "in_meeting"
    await bridge.brain_start()
    g = FakeGemini.instances[-1]
    check(session.brain == "active", "brain=active")
    check(session.media.mic_enabled and recipe.mic_calls[-1] is True, "abre el mic")
    check(g.texts == [], "no habla primero (sin presentación automática)")
    check("MODO REUNIÓN" in (g.prompt or ""), "usa el prompt de reunión")

    print("audio remoto filtrado por nombre")
    await bridge._on_page_message({"type": "remote_pcm", "data": "AAAA"})
    check(len(g.audio) == 0, "conversación sin nombre no llega a Gemini")
    await bridge.brain.feed_remote_pcm(b"WAKE")
    check(len(g.audio) == 1 and g.audio[0].endswith(b"WAKE"), "envía preaudio y nombre al activarse")
    await bridge.brain.feed_remote_pcm(b"\x01\x00" * 1600)
    check(len(g.audio) == 2, "continúa enviando la intervención")

    print("voz de Manglara + half-duplex")
    await g.out.put(b"\x00\x00" * 2400)  # 100 ms de audio a 24 kHz
    await asyncio.sleep(0.05)
    check(any(m["type"] == "bot_pcm" for m in sent), "bot_pcm hacia la página")
    await bridge._on_page_message({"type": "remote_pcm", "data": "AAAA"})
    check(len(g.audio) == 2, "suprime entrada mientras habla")

    print("transcripciones")
    await g.transcript_callback("model", "Hola")
    await g.transcript_callback("user", "Qué tal")
    check(("manglara", "Hola") in transcripts, "rol manglara")
    check(("participant", "Qué tal") in transcripts, "rol participant")
    check({"type": "lip_text", "text": "Hola"} in sent, "lip_text hacia el avatar")

    print("barge-in")
    await g.interrupt_callback()
    check(sent[-1] == {"type": "flush"}, "flush al interrumpir")
    await bridge._on_page_message({"type": "remote_pcm", "data": "AAAA"})
    check(len(g.audio) == 2, "tras flush requiere el nombre de nuevo")
    await bridge.brain.feed_remote_pcm(b"WAKE")
    check(len(g.audio) > 2, "reabre al oír el nombre de nuevo")

    print("reconexión automática")
    await g.out.put(RuntimeError("session expired"))
    await asyncio.sleep(1.3)
    check(len(FakeGemini.instances) == 2, "abre una sesión nueva")
    g2 = FakeGemini.instances[-1]
    check(g2.texts == [], "no se vuelve a presentar")
    check(session.brain == "active", "sigue activa")
    await bridge.brain.feed_remote_pcm(b"\x01\x00" * 1600)
    check(g2.audio == [], "la reconexión exige el nombre de nuevo")

    print("brain_stop")
    await bridge.brain_stop()
    check(session.brain == "off", "brain=off")
    check(g2.closed, "cierra Gemini")
    check(not session.media.mic_enabled, "silencia")

    print("re-start repetido")
    for _ in range(3):
        await bridge.brain_start()
        await bridge.brain_stop()
    check(all(x.closed for x in FakeGemini.instances), "sin sesiones abiertas")
    check(session.brain == "off", "termina apagada")

    print(f"\n{_passed} checks OK")


if __name__ == "__main__":
    asyncio.run(main())
