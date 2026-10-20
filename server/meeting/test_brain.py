"""Tests del cerebro (Gemini on/off) dentro del bridge, con un Gemini falso.

Se corren sin pytest ni red, desde `server/`: `python -m meeting.test_brain`.
Necesitan las env obligatorias de config.py (basta con valores dummy).
"""

import asyncio

from meeting import brain as brain_mod
from meeting.bridge import MeetingBridge
from meeting.models import MeetingSession

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
        self.config = None
        self.resumption_handle = None

    async def connect(self, system_prompt=None, extra_config=None):
        self.prompt = system_prompt
        self.config = extra_config or {}

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
    brain_mod.MeetingBrain._load_knowledge = _no_knowledge
    brain_mod.RECONNECT_WINDOW_S = 0  # toda caída cuenta como "lenta" → reconecta

    session = MeetingSession(provider="zoom", url="https://zoom.us/j/1")
    recipe = FakeRecipe()
    bridge = MeetingBridge(session, recipe)
    bridge.browser.page = object()  # página "viva" para los clicks de receta
    bridge._page_ws = object()  # WS interno "conectado" (send capturado abajo)

    sent: list[dict] = []
    audio_out: list[bytes] = []
    transcripts: list[tuple[str, str]] = []

    async def capture(msg):
        sent.append(msg)

    async def capture_audio(pcm):
        audio_out.append(pcm)

    async def on_transcript(role, text):
        transcripts.append((role, text))

    bridge._send_control = capture
    bridge._send_audio = capture_audio
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
    check("context_window_compression" in g.config, "sesión larga (compresión)")
    check(g.config.get("session_resumption") == {}, "pide handles de reanudación")
    check({"type": "set_listen", "enabled": True} in sent, "la página empieza a escuchar")

    print("audio remoto binario -> Gemini")
    await bridge._on_remote_pcm(b"\x00\x00" * 640)
    check(len(g.audio) == 1, "reenvía PCM binario")
    g.audio.clear()

    print("audio remoto -> Gemini")
    await bridge._on_page_message({"type": "remote_pcm", "data": "AAAA"})
    check(len(g.audio) == 1, "reenvía PCM remoto")

    print("voz de Manglara + half-duplex")
    await g.out.put(b"\x00\x00" * 2400)  # 100 ms de audio a 24 kHz
    await asyncio.sleep(0.05)
    check(audio_out and len(audio_out[0]) == 4800, "voz binaria hacia la página")
    await bridge._on_page_message({"type": "remote_pcm", "data": "AAAA"})
    check(len(g.audio) == 1, "suprime entrada mientras habla")

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
    check(len(g.audio) == 2, "reabre entrada tras flush")

    print("reconexión automática (reanuda la conversación)")
    g.resumption_handle = "h-123"
    await g.out.put(RuntimeError("session expired"))
    await asyncio.sleep(0.5)
    check(len(FakeGemini.instances) == 2, "abre una sesión nueva")
    g2 = FakeGemini.instances[-1]
    check(g2.texts == [], "no se vuelve a presentar")
    check(
        g2.config.get("session_resumption") == {"handle": "h-123"},
        "reconecta con el handle",
    )
    check(session.brain == "active", "sigue activa")

    print("brain_stop")
    await bridge.brain_stop()
    check(session.brain == "off", "brain=off")
    check(g2.closed, "cierra Gemini")
    check(not session.media.mic_enabled, "silencia")
    check(
        [m for m in sent if m["type"] == "set_listen"][-1]["enabled"] is False,
        "la página deja de escuchar",
    )

    print("re-start repetido")
    for _ in range(3):
        await bridge.brain_start()
        await bridge.brain_stop()
    check(all(x.closed for x in FakeGemini.instances), "sin sesiones abiertas")
    check(session.brain == "off", "termina apagada")

    print(f"\n{_passed} checks OK")


if __name__ == "__main__":
    asyncio.run(main())
