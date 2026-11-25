"""Tests of GeminiLiveClient go_away handling and session resumption.

Run without pytest or network, from `server/`: `python -m test_gemini_client`.
They need the required env of config.py (dummy values are enough).
The Live API is replaced by fakes.
"""

import asyncio
from types import SimpleNamespace

from gemini_client import GeminiLiveClient

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


def _response(**fields):
    base = dict(
        server_content=None,
        data=None,
        setup_complete=None,
        go_away=None,
        session_resumption_update=None,
    )
    base.update(fields)
    return SimpleNamespace(**base)


class FakeSession:
    def __init__(self, responses):
        self.responses = responses

    async def receive(self):
        for r in self.responses:
            yield r
        # A real session would keep the socket open: block like it.
        await asyncio.Event().wait()


class FakeContext:
    def __init__(self, live, config):
        self.live = live
        self.config = config

    async def __aenter__(self):
        self.live.configs.append(self.config)
        resumption = self.config.get("session_resumption") or {}
        if resumption.get("handle") and self.live.reject_handle:
            raise RuntimeError("1008 invalid resumption handle")
        return FakeSession([])

    async def __aexit__(self, *exc):
        self.live.exits += 1


class FakeLive:
    def __init__(self, reject_handle=False):
        self.configs: list[dict] = []
        self.exits = 0
        self.reject_handle = reject_handle

    def connect(self, model, config):
        return FakeContext(self, config)


def _client(live: FakeLive) -> GeminiLiveClient:
    client = GeminiLiveClient()
    client.client = SimpleNamespace(aio=SimpleNamespace(live=live))
    return client


async def _drain(client):
    return [chunk async for chunk in client.receive_loop()]


def test_go_away_ends_receive_loop():
    client = _client(FakeLive())
    client.session = FakeSession([
        _response(data=b"audio-1"),
        _response(session_resumption_update=SimpleNamespace(resumable=True, new_handle="h-1")),
        _response(go_away=SimpleNamespace(time_left="10s")),
        _response(data=b"never"),
    ])
    chunks = asyncio.run(asyncio.wait_for(_drain(client), timeout=2))
    check(chunks == [b"audio-1"], "receive_loop stops at go_away instead of waiting for the abort")
    check(client.go_away_received, "go_away is flagged for the caller")
    check(client.resumption_handle == "h-1", "resumption handle kept for the reconnect")


def test_reconnect_resumes_with_handle():
    live = FakeLive()
    client = _client(live)

    async def run():
        await client.connect(system_prompt="p", extra_config={"session_resumption": {}})
        client.resumption_handle = "h-1"
        client.go_away_received = True
        await client.reconnect(system_prompt="p", extra_config={"session_resumption": {}})

    asyncio.run(run())
    check(live.exits == 1, "old session closed before reconnecting")
    check(live.configs[-1]["session_resumption"] == {"handle": "h-1"},
          "reconnect resumes the conversation with the latest handle")
    check(client.session is not None and not client.go_away_received,
          "reconnected session is live and go_away flag reset")


def test_reconnect_falls_back_to_fresh_session():
    live = FakeLive(reject_handle=True)
    client = _client(live)

    async def run():
        await client.connect(extra_config={"session_resumption": {}})
        client.resumption_handle = "h-old"
        await client.reconnect(extra_config={"session_resumption": {}})

    asyncio.run(run())
    check(live.configs[-1]["session_resumption"] == {},
          "rejected handle falls back to a fresh session")
    check(client.session is not None, "fresh session is live after the fallback")


if __name__ == "__main__":
    test_go_away_ends_receive_loop()
    test_reconnect_resumes_with_handle()
    test_reconnect_falls_back_to_fresh_session()
    print(f"{_passed} checks OK")
