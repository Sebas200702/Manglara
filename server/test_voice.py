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
from voice_watchdog import IDLE_MESSAGE, MAX_DURATION_MESSAGE, SessionWatchdog

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
        self.extra_config = extra_config

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


def test_new_sessions_per_minute():
    now = [0.0]
    a = VoiceAdmission(max_new_per_min=2, clock=lambda: now[0])
    check(a.try_acquire("a") is None and a.try_acquire("b") is None, "per-minute cap admits up to the limit")
    a.release("a")
    a.release("b")
    check(a.try_acquire("c") == BUSY_MESSAGE, "per-minute cap counts starts, not active sessions")
    now[0] = 60.0
    check(a.try_acquire("c") is None, "per-minute window slides after 60 s")
    check(a.active == 1, "rejected start did not take a slot")


def test_watchdog():
    now = [0.0]
    w = SessionWatchdog(idle_s=90, max_s=600, clock=lambda: now[0])
    now[0] = 89
    check(w.expired() is None, "watchdog: active before idle timeout")
    w.touch()
    now[0] = 89 + 89
    check(w.expired() is None, "watchdog: touch resets idle timer")
    now[0] = 89 + 90
    check(w.expired() == IDLE_MESSAGE, "watchdog: idle timeout ends session")
    w.touch()
    now[0] = 600
    check(w.expired() == MAX_DURATION_MESSAGE, "watchdog: max duration ends session")
    check(SessionWatchdog(clock=lambda: 1e9).expired() is None, "watchdog: 0 disables both limits")


def test_connect_error_message():
    quota = Exception("1011 None. You exceeded your current quota, please check your plan")
    check(main._connect_error_message(quota) == BUSY_MESSAGE, "quota error shown as busy")
    other = Exception("handshake failed: secret internal detail")
    msg = main._connect_error_message(other)
    check(msg == main.CONNECT_FAILED_MESSAGE and "secret" not in msg, "other connect errors are not leaked")


class FailingGemini(FakeGemini):
    async def connect(self, system_prompt=None, extra_config=None):
        raise RuntimeError("1011 None. You exceeded your current quota")


def test_ws_quota_error_reads_as_busy():
    _use(VoiceAdmission())
    main.GeminiLiveClient = FailingGemini
    try:
        client = TestClient(main.app)
        with client.websocket_connect("/ws/voice") as ws:
            check(ws.receive_json() == {"type": "error", "message": BUSY_MESSAGE}, "gemini quota error reaches client as busy")
    finally:
        main.GeminiLiveClient = FakeGemini
    check(main.voice_admission.active == 0, "slot released after gemini connect failure")


class IdleSocket(FakeSocket):
    """Browser that stays connected but never speaks."""

    async def iter_text(self):
        await asyncio.Event().wait()
        yield ""  # pragma: no cover


def test_idle_session_is_ended():
    FakeGemini.instances.clear()
    _use(VoiceAdmission())
    main.VOICE_IDLE_TIMEOUT_S = 0.05
    sock = IdleSocket()
    try:
        asyncio.run(asyncio.wait_for(main.ws_voice(sock), timeout=5))
        ended = True
    except asyncio.TimeoutError:
        ended = False
    finally:
        main.VOICE_IDLE_TIMEOUT_S = 90
    check(ended, "idle session ends on its own")
    check(sock.sent[-1] == {"type": "session_ended", "message": IDLE_MESSAGE}, "client told why the session ended")
    check(FakeGemini.instances[0].closed and main.voice_admission.active == 0, "idle end closes gemini and frees the slot")


def test_voice_session_uses_context_compression():
    FakeGemini.instances.clear()
    _use(VoiceAdmission())
    asyncio.run(asyncio.wait_for(main.ws_voice(FakeSocket()), timeout=2))
    cfg = FakeGemini.instances[0].extra_config or {}
    check(cfg.get("context_window_compression") == {"sliding_window": {}},
          "voice session asks Gemini for a sliding context window")


def test_live_config_defaults_send_no_temperature_or_vad():
    import gemini_client

    cfg = gemini_client.live_config("prompt")
    check("temperature" not in cfg, "GEMINI_TEMPERATURE unset: no temperature sent")
    saved = gemini_client.GEMINI_TEMPERATURE
    gemini_client.GEMINI_TEMPERATURE = 0.4
    try:
        cfg = gemini_client.live_config("prompt")
    finally:
        gemini_client.GEMINI_TEMPERATURE = saved
    check(cfg.get("temperature") == 0.4, "GEMINI_TEMPERATURE set: sent to Gemini Live")

    FakeGemini.instances.clear()
    _use(VoiceAdmission())
    asyncio.run(asyncio.wait_for(main.ws_voice(FakeSocket()), timeout=2))
    cfg = FakeGemini.instances[0].extra_config or {}
    check("realtime_input_config" not in cfg, "VOICE_VAD_SILENCE_MS unset: Gemini default VAD")


def test_voice_vad_silence_is_configurable():
    saved = main.VOICE_VAD_SILENCE_MS
    main.VOICE_VAD_SILENCE_MS = 700
    try:
        FakeGemini.instances.clear()
        _use(VoiceAdmission())
        asyncio.run(asyncio.wait_for(main.ws_voice(FakeSocket()), timeout=2))
    finally:
        main.VOICE_VAD_SILENCE_MS = saved
    cfg = FakeGemini.instances[0].extra_config or {}
    check(cfg.get("realtime_input_config") == {
        "automatic_activity_detection": {"silence_duration_ms": 700}
    }, "VOICE_VAD_SILENCE_MS set: end-of-speech silence sent")
    check(cfg.get("context_window_compression") == {"sliding_window": {}},
          "VAD setting keeps the sliding context window")


class VisitorTurnGemini(FakeGemini):
    """The visitor says one sentence and Manglara answers (no audio)."""

    async def receive_loop(self):
        await self.on_user_partial_transcript("hola secreto")
        await self.turn_complete_callback()
        await asyncio.Event().wait()
        yield b""  # pragma: no cover


class LingeringSocket(FakeSocket):
    """Browser that stays a moment, so Gemini's side gets to run."""

    async def iter_text(self):
        await asyncio.sleep(0.1)
        return
        yield  # pragma: no cover


def test_turn_metric_logged_without_transcript():
    import logging

    records = []
    handler = logging.Handler()
    handler.emit = lambda r: records.append(r.getMessage())
    main.logger.addHandler(handler)
    main.GeminiLiveClient = VisitorTurnGemini
    try:
        _use(VoiceAdmission())
        asyncio.run(asyncio.wait_for(main.ws_voice(LingeringSocket()), timeout=2))
    finally:
        main.GeminiLiveClient = FakeGemini
        main.logger.removeHandler(handler)
    turns = [m for m in records if m.startswith("[metric] turn ")]
    check(len(turns) == 1 and '"context": "none"' in turns[0], "each visitor turn logs one metric line")
    check(any(m.startswith("[metric] session ") for m in records), "session end logs the metric summary")
    check(not any("secreto" in m for m in records if m.startswith("[metric]")),
          "metric lines never carry transcript text")


class LeavingSocket(FakeSocket):
    """Browser that closed the tab while Gemini was connecting."""

    async def send_json(self, data):
        raise RuntimeError("websocket is closed")


def test_browser_leaving_before_ready_closes_gemini():
    FakeGemini.instances.clear()
    _use(VoiceAdmission())
    asyncio.run(asyncio.wait_for(main.ws_voice(LeavingSocket()), timeout=2))
    check(FakeGemini.instances[0].closed, "gemini closed when the browser left before session_ready")
    check(main.voice_admission.active == 0, "slot released when the browser left before session_ready")


class TalkingGemini(FakeGemini):
    """Model that keeps answering (output transcription) for a while."""

    async def receive_loop(self):
        for _ in range(8):
            await asyncio.sleep(0.05)
            await self.transcript_callback("model", "parte de una respuesta larga ")
        await asyncio.Event().wait()
        yield b""  # pragma: no cover


def test_model_speech_counts_as_activity():
    _use(VoiceAdmission())
    main.GeminiLiveClient = TalkingGemini
    main.VOICE_IDLE_TIMEOUT_S = 0.2
    sock = IdleSocket()
    try:
        asyncio.run(asyncio.wait_for(main.ws_voice(sock), timeout=5))
    finally:
        main.GeminiLiveClient = FakeGemini
        main.VOICE_IDLE_TIMEOUT_S = 90
    model_parts = [m for m in sock.sent if m.get("type") == "transcript"]
    check(len(model_parts) == 8, "a 0.4 s answer is not cut by a 0.2 s idle timeout")
    check(sock.sent[-1].get("type") == "session_ended", "idle timeout still ends the session after the answer")


def test_meeting_debug_ui_rejects_forwarded_loopback():
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(meeting_router_mod.router)
    client = TestClient(app, client=("127.0.0.1", 5000))
    r = client.get("/meetings/x/debug/ui", headers={"x-forwarded-for": "127.0.0.1"})
    check(r.status_code == 403, "debug/ui rejects loopback that came through a proxy")
    r = client.get("/meetings/x/debug/ui")
    check(r.status_code == 404, "debug/ui still allows real local requests (unknown session -> 404)")


def test_health_accepts_head_for_uptime_monitors():
    client = TestClient(main.app)
    get = client.get("/health")
    check(get.status_code == 200 and get.json() == {"ok": True}, "GET /health still returns ok")
    head = client.head("/health")
    check(head.status_code == 200, "HEAD /health returns 200 (UptimeRobot default)")
    check(head.content == b"", "HEAD /health has no body")


def test_meetings_api_requires_admin_on_both_paths():
    client = TestClient(main.app)
    check(client.get("/meetings").status_code == 401, "/meetings without session: 401")
    check(client.get("/api/meetings").status_code == 401, "/api/meetings without session: 401")
    from knowledge.auth import COOKIE_NAME, make_session_token
    client.cookies.set(COOKIE_NAME, make_session_token())
    check(client.get("/api/meetings").status_code == 200, "/api/meetings with session: 200")


if __name__ == "__main__":
    test_meetings_api_requires_admin_on_both_paths()
    test_health_accepts_head_for_uptime_monitors()
    test_admission_unit()
    test_ws_default_unchanged()
    test_ws_origin_rejected()
    test_ws_cap_and_release()
    test_session_ends_when_browser_disconnects()
    test_new_sessions_per_minute()
    test_watchdog()
    test_connect_error_message()
    test_ws_quota_error_reads_as_busy()
    test_idle_session_is_ended()
    test_voice_session_uses_context_compression()
    test_live_config_defaults_send_no_temperature_or_vad()
    test_voice_vad_silence_is_configurable()
    test_turn_metric_logged_without_transcript()
    test_browser_leaving_before_ready_closes_gemini()
    test_model_speech_counts_as_activity()
    test_meeting_debug_ui_rejects_forwarded_loopback()
    print(f"{_passed} checks OK")
