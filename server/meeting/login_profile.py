"""Setup único del perfil logueado del bot (MEETING_CHROME_PROFILE_DIR).

Abre Chromium VISIBLE con el mismo perfil persistente que usa el bot, para
iniciar sesión a mano en Google (Meet de workspace) y/o Microsoft (Teams).
Las cookies quedan en el perfil y las reuniones siguientes entran logueadas.

Uso, desde server/ (con el backend detenido: un perfil no admite dos browsers):

    python -m meeting.login_profile

Inicia sesión en las pestañas abiertas y cierra la ventana al terminar.
"""

import asyncio
import os
import sys

from playwright.async_api import async_playwright

from config import MEETING_CHROME_PROFILE_DIR

LOGIN_PAGES = [
    "https://accounts.google.com/",
    "https://teams.microsoft.com/",
]


async def main() -> int:
    profile = MEETING_CHROME_PROFILE_DIR
    if not profile:
        print(
            "MEETING_CHROME_PROFILE_DIR no está definido.\n"
            "Ponlo en .env (p. ej. MEETING_CHROME_PROFILE_DIR=./.meeting-profile) "
            "y vuelve a correr este comando."
        )
        return 1
    os.makedirs(profile, exist_ok=True)
    print(f"Perfil: {os.path.abspath(profile)}")
    print("Inicia sesión en las pestañas abiertas y CIERRA la ventana al terminar.")

    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            profile,
            headless=False,
            locale="es-ES",
            viewport=None,
            args=["--no-first-run"],
        )
        closed = asyncio.Event()
        context.on("close", lambda _: closed.set())
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(LOGIN_PAGES[0])
        for url in LOGIN_PAGES[1:]:
            extra = await context.new_page()
            await extra.goto(url)
        await closed.wait()
    print("Perfil guardado. El bot usará esta sesión en las próximas reuniones.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
