"""Chromium headless para el bot de reuniones (Playwright).

Un browser por reunión. El script `audio_bridge.js` se instala con
`add_init_script` ANTES de navegar, así los overrides de getUserMedia y
RTCPeerConnection ya están activos cuando la página del proveedor carga.
"""

import json
import logging
import os
from urllib.parse import urljoin, urlparse

from playwright.async_api import async_playwright

from config import (
    MEETING_AVATAR_URL,
    MEETING_CHROME_PROFILE_DIR,
    MEETING_HEADLESS,
    MEETING_WEB_URL,
)

logger = logging.getLogger(__name__)

_BRIDGE_JS_PATH = os.path.join(os.path.dirname(__file__), "audio_bridge.js")

with open(_BRIDGE_JS_PATH, encoding="utf-8") as f:
    _BRIDGE_JS = f.read()


def resolve_avatar_url() -> str:
    """URL absoluta de la página del avatar, o "" si no hay web configurada."""
    raw = (MEETING_AVATAR_URL or "").strip()
    if not raw:
        return ""
    if urlparse(raw).scheme in ("http", "https"):
        return raw
    if not MEETING_WEB_URL:
        return ""
    return urljoin(MEETING_WEB_URL + "/", raw.lstrip("/"))


def build_init_script(ws_url: str, session_id: str, selectors: dict) -> str:
    """Pre-script + bridge. `selectors` viene de la receta del proveedor."""
    avatar_url = resolve_avatar_url()
    avatar_origin = ""
    if avatar_url:
        parts = urlparse(avatar_url)
        avatar_origin = f"{parts.scheme}://{parts.netloc}"
    cfg = json.dumps(
        {
            "wsUrl": ws_url,
            "sessionId": session_id,
            "avatarUrl": avatar_url,
            "avatarOrigin": avatar_origin,
        }
    )
    sel = json.dumps(selectors or {})
    return (
        f"window.__MANGLARA_CFG={cfg};\n"
        f"window.__MEETING_SELECTORS__={sel};\n{_BRIDGE_JS}"
    )


class MeetingBrowser:
    """Dueño del ciclo de vida de Playwright para una sesión."""

    def __init__(self):
        self._pw = None
        self._browser = None
        self._context = None
        self.page = None

    async def launch(self, ws_url: str, session_id: str, selectors: dict):
        self._pw = await async_playwright().start()

        # headless=new de Chromium completo (no headless-shell): WebRTC y
        # WebAudio funcionan igual que en headed. Para debug de selectores,
        # MEETING_HEADLESS=false abre ventana visible.
        args = [
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-ui-for-media-stream",
            "--no-first-run",
            "--mute-audio",
            # El avatar (iframe) y el WS interno corren en un origen local
            # embebido en una página pública https: sin estos flags Chrome
            # puede bloquearlos (Private/Local Network Access) o frenar el
            # render de la pestaña y del iframe en segundo plano.
            "--disable-features=PrivateNetworkAccessSendPreflights,"
            "PrivateNetworkAccessRespectPreflightResults,"
            "BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            # WebGL del avatar por software si no hay GPU (servidores).
            "--enable-unsafe-swiftshader",
        ]
        headless = False
        if MEETING_HEADLESS:
            args = ["--headless=new"] + args

        init_script = build_init_script(ws_url, session_id, selectors)

        if MEETING_CHROME_PROFILE_DIR:
            logger.info(
                "[meeting] perfil persistente: %s", MEETING_CHROME_PROFILE_DIR
            )
            self._context = (
                await self._pw.chromium.launch_persistent_context(
                    MEETING_CHROME_PROFILE_DIR,
                    headless=headless,
                    args=args,
                    viewport={"width": 1280, "height": 720},
                    locale="es-ES",
                    # La CSP del proveedor bloquearía el WS interno a
                    # 127.0.0.1 (connect-src) y el iframe del avatar (frame-src).
                    bypass_csp=True,
                )
            )
        else:
            self._browser = await self._pw.chromium.launch(
                headless=headless, args=args
            )
            self._context = await self._browser.new_context(
                viewport={"width": 1280, "height": 720},
                locale="es-ES",
                bypass_csp=True,
            )

        await self._context.grant_permissions(["microphone", "camera"])
        await self._context.add_init_script(init_script)
        self.page = await self._context.new_page()
        logger.info("[meeting] browser listo (headless=%s)", MEETING_HEADLESS)

    async def close(self):
        if self._context:
            try:
                await self._context.close()
            except Exception:
                pass
            self._context = None
        if self._browser:
            try:
                await self._browser.close()
            except Exception:
                pass
            self._browser = None
        if self._pw:
            try:
                await self._pw.stop()
            except Exception:
                pass
            self._pw = None
        self.page = None
        logger.info("[meeting] browser cerrado")
