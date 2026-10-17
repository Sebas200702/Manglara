"""Interfaz de recetas de join por proveedor + helpers Playwright.

Cada receta declara SELECTORS (para el poll de la página inyectada) y los
pasos de join/salida/mic/cam. Los selectores cambian seguido: cada archivo
anota su fecha de última verificación real.
"""

import logging
import re

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


def _candidate_locator(page, c: dict, anchored: bool = False):
    """Locator de un candidato: botón con ese nombre accesible o texto visible.

    - `{"selector": css}`: tal cual.
    - `{"text": t}`: subcadena, sin distinguir mayúsculas.
    - `{"text": t, "exact": True}` o `anchored=True`: el nombre EMPIEZA por `t`.
      Necesario donde un texto contiene a otro: "Unmute" contiene "Mute",
      "Desactivar micrófono" contiene "Activar micrófono", "Join from Your
      Browser" empieza como el botón "Join". Admite sufijos como atajos de
      teclado ("Silenciar (Ctrl+Mayús+M)").
    """
    if "selector" in c:
        return page.locator(c["selector"])
    text = c["text"]
    if c.get("exact"):
        name = re.compile(r"^\s*" + re.escape(text) + r"\s*$", re.I)
    elif anchored:
        name = re.compile(r"^\s*" + re.escape(text), re.I)
    else:
        name = text
    return page.get_by_role("button", name=name).or_(page.get_by_text(name))


def _any_visible_locator(page, candidates: list, anchored: bool = False):
    combined = None
    for c in candidates:
        loc = _candidate_locator(page, c, anchored)
        combined = loc if combined is None else combined.or_(loc)
    return combined.filter(visible=True).first if combined is not None else None


def _describe(candidates: list) -> str:
    return " | ".join(str(c.get("text") or c.get("selector")) for c in candidates)


async def click_first(
    page, candidates: list, timeout_ms: int = STEP_TIMEOUT_MS, anchored: bool = False
) -> bool:
    """Click al primer candidato que aparezca visible (espera única).

    Candidato: {'text': ..., 'exact'?: bool} o {'selector': ...}.
    """
    loc = _any_visible_locator(page, candidates, anchored)
    if loc is None:
        return False
    try:
        await loc.wait_for(state="visible", timeout=timeout_ms)
        await loc.click(timeout=5000)
        logger.info("[recipe] click: %s", _describe(candidates))
        return True
    except Exception:
        return False


async def press_until_gone(
    page,
    candidates: list,
    dom_selector: str = "",
    dom_text: str = "",
    attempts: int = 4,
    first_timeout_ms: int = STEP_TIMEOUT_MS,
) -> bool:
    """Pulsa un botón hasta que desaparezca (la página avanzó).

    Los proveedores ignoran clicks antes de hidratar, y el click de Playwright
    sobre el texto puede caer en un span interno sin handler: tras cada click
    sin efecto se hace un click DOM directo (`dom_selector`, o el primer botón
    cuyo aria-label/texto cumpla la regex `dom_text`). True si llegó a pulsarlo.
    """
    pressed = False
    for attempt in range(attempts):
        timeout = first_timeout_ms if attempt == 0 else 4000
        if not await click_first(page, candidates, timeout_ms=timeout):
            return pressed
        pressed = True
        await page.wait_for_timeout(2500)
        if not await _any_visible(page, candidates):
            return True
        try:
            await page.evaluate(
                """([sel, re]) => {
                  let b = sel ? document.querySelector(sel) : null;
                  if (!b && re) {
                    const rx = new RegExp(re, 'i');
                    b = [...document.querySelectorAll('button, [role=button]')].find(
                      (x) => rx.test(x.getAttribute('aria-label') || '') ||
                             rx.test(x.innerText || ''));
                  }
                  if (b) b.click();
                }""",
                [dom_selector, dom_text],
            )
        except Exception:
            pass
        await page.wait_for_timeout(2500)
        if not await _any_visible(page, candidates):
            return True
        logger.info("[recipe] el botón sigue visible, reintento (%d)", attempt + 1)
    return pressed


async def fill_first(page, candidates: list, value: str) -> bool:
    combined = None
    for c in candidates:
        if "text" in c:
            loc = page.get_by_placeholder(c["text"], exact=False)
        elif "label" in c:
            loc = page.get_by_label(c["label"], exact=False)
        else:
            loc = page.locator(c["selector"])
        combined = loc if combined is None else combined.or_(loc)
    if combined is None:
        return False
    try:
        target = combined.filter(visible=True).first
        await target.wait_for(state="visible", timeout=STEP_TIMEOUT_MS)
        await target.fill(value)
        logger.info("[recipe] fill: %s", _describe(candidates))
        return True
    except Exception:
        return False


async def click_mic_button(page, enable: bool, when_muted: list, when_live: list):
    """Lleva el mic de la reunión al estado pedido (best-effort).

    `when_muted`: botones visibles con el mic SILENCIADO (p. ej. "Unmute").
    `when_live`: botones visibles con el mic ABIERTO (p. ej. "Mute").
    Para abrir se pulsa un botón de `when_muted`; si ya se ve uno de
    `when_live`, ya está abierto y no se toca (y al revés para silenciar).
    """
    already = when_live if enable else when_muted
    to_click = when_muted if enable else when_live
    if await _any_visible(page, already):
        return True
    return await click_first(page, to_click, timeout_ms=8000, anchored=True)


async def _any_visible(page, candidates: list) -> bool:
    loc = _any_visible_locator(page, candidates, anchored=True)
    if loc is None:
        return False
    try:
        return await loc.is_visible()
    except Exception:
        return False
