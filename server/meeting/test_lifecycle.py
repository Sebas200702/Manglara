"""Tests del ciclo de vida del bridge (resiliencia) con browser y receta falsos.

Se corren sin pytest, red ni Chromium, desde `server/`:
`python -m meeting.test_lifecycle`. Necesitan las env obligatorias de
config.py (basta con valores dummy).
"""

import asyncio

from meeting import bridge as bridge_mod
from meeting.bridge import MeetingBridge
from meeting.models import MeetingSession

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


class FakePage:
    def __init__(self):
        self.alive = True

    async def goto(self, url, timeout=0):
        pass

    async def evaluate(self, expr):
        if not self.alive:
            await asyncio.sleep(10)  # página colgada
        return 1


class FakeBrowser:
    def __init__(self):
        self.page = None
        self.on_lost = None
        self.lost_reason = None
        self.closed = False

    async def launch(self, ws_url, session_id, selectors, ws_token=""):
        self.page = FakePage()

    @property
    def alive(self):
        return self.page is not None and self.lost_reason is None

    def kill(self, reason="proceso matado"):
        self.lost_reason = reason
        self.on_lost(reason)

    async def close(self):
        self.closed = True
        self.page = None


class FakeRecipe:
    selectors: dict = {}

    def __init__(self, states, alone=False):
        self.states = list(states)
        self.alone = alone
        self.left_clicked = False

    def entry_url(self, url):
        return url

    async def join(self, page, name):
        pass

    async def poll_state(self, page):
        return self.states.pop(0) if len(self.states) > 1 else self.states[0]

    async def is_alone(self, page):
        return self.alone

    async def leave(self, page):
        self.left_clicked = True

    async def set_mic(self, page, enabled):
        pass

    async def set_cam(self, page, enabled):
        pass


def make(states, alone=False, connect_ws=True):
    session = MeetingSession(provider="meet", url="https://meet.google.com/abc-defg-hij")
    recipe = FakeRecipe(states, alone=alone)
    events: list[str] = []

    async def on_event(s):
        events.append(s.bridge)

    b = MeetingBridge(session, recipe, on_event=on_event)
    b.browser = FakeBrowser()
    if connect_ws:
        b._page_ws = object()  # WS interno "conectado"

        async def _noop(msg):
            pass

        b._send_control = _noop
    return session, recipe, b, events


async def wait_until(cond, timeout=3.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError("timeout esperando condición")
        await asyncio.sleep(0.01)


async def main():
    bridge_mod.POLL_INTERVAL_S = 0.02
    bridge_mod.WS_DEAD_S = 0.15
    bridge_mod.MEETING_ALONE_TIMEOUT_MIN = 0.3 / 60  # 0.3 s

    print("join -> lobby -> in_meeting -> leave del usuario")
    s, r, b, events = make(["lobby", "lobby", "in_meeting"])
    task = asyncio.create_task(b.run())
    await wait_until(lambda: s.bridge == "in_meeting")
    check("lobby" in events, "pasa por lobby")
    await b.leave()
    await task
    check(s.bridge == "closed" and s.end_reason == "user", "closed por el usuario")
    check(r.left_clicked, "pulsa Salir en la reunión")
    check(b.browser.closed, "cierra el browser")
    check(s.id not in bridge_mod.BRIDGES, "libera el registro")

    print("la reunión termina")
    s, r, b, _ = make(["in_meeting", "left"])
    await b.run()
    check(s.bridge == "closed" and s.end_reason == "ended", "closed con end_reason=ended")
    check(not r.left_clicked, "no busca el botón Salir")

    print("browser matado a mano")
    s, r, b, _ = make(["in_meeting"])
    task = asyncio.create_task(b.run())
    await wait_until(lambda: s.bridge == "in_meeting")
    b.browser.kill()
    await task
    check(s.bridge == "error", "estado error")
    check("navegador" in (s.error or "") and "proceso matado" in s.error, "mensaje claro")
    check(b.browser.closed, "limpia el browser")

    print("WS interno muerto (página viva): 1 reintento y luego error")
    s, r, b, _ = make(["in_meeting"], connect_ws=False)
    t0 = asyncio.get_running_loop().time()
    await b.run()
    elapsed = asyncio.get_running_loop().time() - t0
    check(s.bridge == "error" and "conexión" in (s.error or ""), "error de conexión")
    check(elapsed >= 2 * bridge_mod.WS_DEAD_S, "esperó el reintento")

    print("WS interno reconecta dentro de la ventana")
    s, r, b, _ = make(["in_meeting"], connect_ws=False)
    task = asyncio.create_task(b.run())
    await asyncio.sleep(0.1)
    b._page_ws = object()  # la página volvió
    b._ws_down_since = None
    await asyncio.sleep(0.4)
    check(s.bridge == "in_meeting", "sigue en la reunión")
    await b.leave()
    await task

    print("se queda sola")
    s, r, b, _ = make(["in_meeting"], alone=True)
    await b.run()
    check(s.bridge == "closed" and s.end_reason == "alone", "sale con end_reason=alone")

    print("duración máxima")
    bridge_mod.MEETING_MAX_DURATION_MIN = 0.2 / 60  # 0.2 s
    s, r, b, _ = make(["in_meeting"])
    await b.run()
    check(s.bridge == "closed" and s.end_reason == "max_duration", "sale por duración máxima")

    print(f"\n{_passed} checks OK")


if __name__ == "__main__":
    asyncio.run(main())
