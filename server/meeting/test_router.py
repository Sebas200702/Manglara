"""Tests de la API REST de reuniones (cola de 1, errores en español).

Se corren sin pytest ni Chromium, desde `server/`:
`python -m meeting.test_router`. Necesitan las env obligatorias de config.py
(basta con valores dummy).
"""

import asyncio

from fastapi import FastAPI, WebSocketDisconnect
from fastapi.testclient import TestClient

from meeting import router as router_mod

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


class FakeBridge:
    """Se "une" al instante y espera a leave()."""

    def __init__(self, session, recipe, on_event=None, on_transcript=None):
        self.session = session
        self._left = asyncio.Event()

    async def run(self):
        self.session.bridge = "in_meeting"
        await self._left.wait()
        self.session.bridge = "closed"
        self.session.end_reason = "user"
        router_mod.BRIDGES.pop(self.session.id, None)

    async def leave(self):
        self._left.set()
        await asyncio.sleep(0.01)


def main():
    router_mod.MeetingBridge = FakeBridge
    app = FastAPI()
    app.include_router(router_mod.router)
    app.include_router(router_mod.ws_router)

    with TestClient(app) as client:
        print("join")
        r = client.post("/meetings/join", json={"input": "https://zoom.us/j/81234567890"})
        check(r.status_code == 202, "202 al unirse")
        first = r.json()["id"]
        check(r.json()["provider"] == "zoom", "detecta zoom")
        check("url" not in r.json(), "no expone la URL")

        print("segundo join con una activa")
        r = client.post("/meetings/join", json={"input": "abc-defg-hij"})
        check(r.status_code == 409, "409")
        check("ya está en una reunión" in r.json()["detail"], "mensaje en español")

        print("listado de debug")
        r = client.get("/meetings")
        check(r.json()["active"] == first, "reporta la activa")

        print("WS interno protegido")
        check("bridge_token" not in r.text, "el listado no expone el token")
        path = f"/ws/meetings/{first}/bridge"
        real = router_mod.SESSIONS[first].bridge_token
        for label, protos in (
            ("sin token", []),
            ("token adivinado", ["manglara.bridge", "t.adivinado"]),
            # El token correcto desde un host no-loopback ("testclient").
            ("host no local", ["manglara.bridge", f"t.{real}"]),
        ):
            try:
                with client.websocket_connect(path, subprotocols=protos) as ws:
                    ws.receive_text()
                check(False, "debía rechazar")
            except WebSocketDisconnect as e:
                check(e.code == 4403, f"rechaza {label}")

        print("leave libera el cupo")
        r = client.post(f"/meetings/{first}/leave")
        check(r.status_code == 200, "leave 200")
        r = client.get(f"/meetings/{first}")
        check(r.json()["bridge"] == "closed", "queda closed")
        r = client.post("/meetings/join", json={"input": "abc-defg-hij"})
        check(r.status_code == 202 and r.json()["provider"] == "meet", "nuevo join permitido")
        client.post(f"/meetings/{r.json()['id']}/leave")

        print("validación de entrada")
        r = client.post("/meetings/join", json={"input": "https://example.com/x"})
        check(r.status_code == 422, "422 dominio no soportado")
        check(isinstance(r.json()["detail"], str), "detalle legible")
        r = client.post("/meetings/join", json={"input": "x" * 501})
        check(r.status_code == 422, "422 input demasiado largo")
        r = client.post("/meetings/nope/leave")
        check(r.status_code == 404, "404 reunión inexistente")

    print(f"\n{_passed} checks OK")


if __name__ == "__main__":
    main()
