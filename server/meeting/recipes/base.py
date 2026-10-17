"""Interfaz de recetas de join por proveedor + helpers Playwright.

Cada receta declara SELECTORS (para el poll de la página inyectada) y los
pasos de join/salida/mic/cam. Los selectores cambian seguido: cada archivo
anota su fecha de última verificación real.
"""

import logging

logger = logging.getLogger(__name__)

STEP_TIMEOUT_MS = 15000


class JoinRecipe:
    provider = "base"
    last_verified = "sin verificar (pendiente de reunión real)"

    # Para window.__MEETING_SELECTORS__: listas de {selector} y/o {text}.
    # "alone" (opcional): visible cuando el bot es el único participante;
    # alimenta el auto-leave (MEETING_ALONE_TIMEOUT_MIN).
    selectors: dict = {
        "joining": [],
        "lobby": [],
        "inMeeting": [],
        "left": [],
        "alone": [],
    }

    def entry_url(self, url: str) -> str:
        return url

    async def join(self, page, name: str):
        raise NotImplementedError

    async def poll_state(self, page) -> str:
        """'joining' | 'lobby' | 'in_meeting' | 'left' | 'unknown'."""
        return await poll_with_selectors(page, self.selectors)

    async def is_alone(self, page) -> bool:
        """True si la UI indica que no hay más participantes."""
        alone = self.selectors.get("alone") or []
        if not alone:
            return False
        return await poll_with_selectors(page, {"left": alone}) == "left"

    async def leave(self, page):
        raise NotImplementedError

    async def set_mic(self, page, enabled: bool):
        raise NotImplementedError

    async def set_cam(self, page, enabled: bool):
        raise NotImplementedError


async def poll_with_selectors(page, selectors: dict) -> str:
    """Evalúa en página: left > in_meeting > lobby > joining > unknown."""
    try:
        return await page.evaluate(
            """(sel) => {
              const any = (list) => (list || []).some(m => {
                try {
                  if (m.selector && document.querySelector(m.selector)) return true;
                  if (m.text && document.body && document.body.innerText &&
                      document.body.innerText.includes(m.text)) return true;
                } catch (_) {}
                return false;
              });
              if (any(sel.left)) return 'left';
              if (any(sel.inMeeting)) return 'in_meeting';
              if (any(sel.lobby)) return 'lobby';
              if (any(sel.joining)) return 'joining';
              return 'unknown';
            }""",
            selectors,
        )
    except Exception as e:
        logger.warning("[recipe] poll falló: %s", type(e).__name__)
        return "unknown"


async def click_first(page, candidates: list, timeout_ms: int = STEP_TIMEOUT_MS) -> bool:
    """Click al primer candidato visible. Candidato: {'text':..} o {'selector':..}."""
    for c in candidates:
        try:
            if "text" in c:
                loc = page.get_by_text(c["text"], exact=False)
            else:
                loc = page.locator(c["selector"])
            await loc.first.wait_for(state="visible", timeout=timeout_ms)
            await loc.first.click(timeout=5000)
            logger.info("[recipe] click: %s", c)
            return True
        except Exception:
            continue
    return False


async def fill_first(page, candidates: list, value: str) -> bool:
    for c in candidates:
        try:
            if "text" in c:
                loc = page.get_by_placeholder(c["text"], exact=False)
            elif "label" in c:
                loc = page.get_by_label(c["label"], exact=False)
            else:
                loc = page.locator(c["selector"])
            await loc.first.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
            await loc.first.fill(value)
            logger.info("[recipe] fill: %s", c)
            return True
        except Exception:
            continue
    return False


async def click_mic_button(page, enable: bool, when_muted: list, when_live: list):
    """Click best-effort al botón de mic según el estado deseado."""
    candidates = when_live if enable else when_muted
    # Si ya está en el estado deseado, el botón opuesto no existe: no hacer nada.
    opposite = when_muted if enable else when_live
    try:
        if await _any_visible(page, opposite):
            return True
    except Exception:
        pass
    return await click_first(page, candidates, timeout_ms=8000)


async def _any_visible(page, candidates: list) -> bool:
    for c in candidates:
        try:
            loc = (
                page.get_by_text(c["text"], exact=False)
                if "text" in c
                else page.locator(c["selector"])
            )
            if await loc.first.is_visible():
                return True
        except Exception:
            continue
    return False
