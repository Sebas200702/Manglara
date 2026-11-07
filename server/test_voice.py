"""Tests of the public voice WebSocket admission and session teardown.

Run without pytest or network, from `server/`: `python -m test_voice`.
They need the required env of config.py (dummy values are enough).
Gemini and Supabase are replaced by fakes.
"""

import asyncio
import time

from fastapi.testclient import TestClient

import main
from meeting import router as meeting_router_mod
from voice_admission import BUSY_MESSAGE, ORIGIN_MESSAGE, VoiceAdmission

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


class FakeGemini:
    """Never sends audio: receive_loop blocks like a real idle Live session."""

    instances: list["FakeGemini"] = []

    def __init__(self):
        self.closed = False
        self.log_transcripts = True
        FakeGemini.instances.append(self)

    async def connect(self, system_prompt=None, extra_config=None):
        pass

    async def receive_loop(self):
        await asyncio.Event().wait()
        yield b""  # pragma: no cover (makes this an async generator)

    async def send_audio_pcm16_16k(self, pcm):
        pass

    async def inject_context(self, text):
        pass

    async def close(self):
        self.closed = True


async def _no_docs():
    return []


async def _no_knowledge(ids):
    return ""


main.GeminiLiveClient = FakeGemini
main.list_active_documents = _no_docs
main.build_knowledge_context = _no_knowledge


def _use(admission: VoiceAdmission):
    main.voice_admission = admission


def _wait_for(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return cond()


def test_admission_unit():
    a = VoiceAdmission()
    check(a.origin_allowed(None) and a.origin_allowed("https://x"), "no allowlist admits any origin")
    check(a.try_acquire("1.1.1.1") is None, "no cap admits")

    a = VoiceAdmission(allowed_origins=["https://manglara.app/"])
    check(a.origin_allowed("https://manglara.app"), "allowlisted origin admitted (trailing slash ignored)")
    check(not a.origin_allowed("https://evil.example"), "foreign origin rejected")
    check(not a.origin_allowed(None), "missing origin rejected when allowlist set")

    a = VoiceAdmission(max_sessions=2)
    check(a.try_acquire("a") is None and a.try_acquire("b") is None, "global cap admits up to the limit")
    check(a.try_acquire("c") == BUSY_MESSAGE, "global cap rejects over the limit")
    a.release("a")
    check(a.try_acquire("c") is None, "released slot is reusable")

    a = VoiceAdmission(max_per_ip=1)
    check(a.try_acquire("ip1") is None, "per-ip cap admits first")
    check(a.try_acquire("ip1") == BUSY_MESSAGE, "per-ip cap rejects second from same ip")
    check(a.try_acquire("ip2") is None, "per-ip cap does not affect other ips")
    a.release("ip1")
    check(a.try_acquire("ip1") is None, "per-ip slot freed on release")


def test_ws_default_unchanged():
    _use(VoiceAdmission())
    client = TestClient(main.app)
    with client.websocket_connect("/ws/voice") as ws:
        check(ws.receive_json() == {"type": "session_ready"}, "defaults: session opens with no origin and no caps")


def test_ws_origin_rejected():
    _use(VoiceAdmission(allowed_origins=["https://manglara.app"]))
    client = TestClient(main.app)
    with client.websocket_connect("/ws/voice", headers={"origin": "https://evil.example"}) as ws:
        check(ws.receive_json() == {"type": "error", "message": ORIGIN_MESSAGE}, "foreign origin gets error message")
    with client.websocket_connect("/ws/voice", headers={"origin": "https://manglara.app"}) as ws:
        check(ws.receive_json() == {"type": "session_ready"}, "allowed origin opens session")


def test_ws_cap_and_release():
    FakeGemini.instances.clear()
    _use(VoiceAdmission(max_sessions=1))
    client = TestClient(main.app)
    with client.websocket_connect("/ws/voice") as first:
        check(first.receive_json() == {"type": "session_ready"}, "first session admitted")
        with client.websocket_connect("/ws/voice") as second:
            check(second.receive_json() == {"type": "error", "message": BUSY_MESSAGE}, "second session gets busy message")
    check(len(FakeGemini.instances) == 1, "rejected session never opened Gemini")
    # Client gone: the idle Gemini session must be closed and the slot freed
    # (the old gather kept it open until Gemini closed it).
    check(_wait_for(lambda: FakeGemini.instances[0].closed), "gemini closed after browser disconnect")
    check(_wait_for(lambda: main.voice_admission.active == 0), "slot released after disconnect")
    with client.websocket_connect("/ws/voice") as again:
        check(again.receive_json() == {"type": "session_ready"}, "new session admitted after release")


class FakeSocket:
    """Browser that sends nothing and disconnects. Unlike TestClient, closing
    it never cancels the handler, which is how uvicorn behaves."""

    headers: dict = {}
    client = None

    def __init__(self):
        self.sent = []

    async def accept(self):
        pass

    async def send_json(self, data):
        self.sent.append(data)

    async def iter_text(self):
        return
        yield  # pragma: no cover

    async def close(self):
        pass


def test_session_ends_when_browser_disconnects():
    FakeGemini.instances.clear()
    _use(VoiceAdmission(max_sessions=1))

    async def run():
        await asyncio.wait_for(main.ws_voice(FakeSocket()), timeout=2)

    try:
        asyncio.run(run())
        ended = True
    except asyncio.TimeoutError:
        ended = False
    check(ended, "handler returns after browser disconnect while Gemini is idle")
    check(FakeGemini.instances[0].closed, "gemini session closed on browser disconnect")
    check(main.voice_admission.active == 0, "slot released on browser disconnect")


def test_meeting_debug_ui_rejects_forwarded_loopback():
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(meeting_router_mod.router)
    client = TestClient(app, client=("127.0.0.1", 5000))
    r = client.get("/meetings/x/debug/ui", headers={"x-forwarded-for": "127.0.0.1"})
    check(r.status_code == 403, "debug/ui rejects loopback that came through a proxy")
    r = client.get("/meetings/x/debug/ui")
    check(r.status_code == 404, "debug/ui still allows real local requests (unknown session -> 404)")


if __name__ == "__main__":
    test_admission_unit()
    test_ws_default_unchanged()
    test_ws_origin_rejected()
    test_ws_cap_and_release()
    test_session_ends_when_browser_disconnects()
    test_meeting_debug_ui_rejects_forwarded_loopback()
    print(f"{_passed} checks OK")
