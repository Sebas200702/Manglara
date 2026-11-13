"""Tests of the meeting bot's Chromium launch flags.

Run from `server/`: `python -m meeting.test_browser` (needs the dummy env of
config.py). No browser is started.
"""

from meeting.browser import chromium_args

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


def test_shm_flag():
    for headless in (True, False):
        args = chromium_args(headless)
        check("--disable-dev-shm-usage" in args, f"headless={headless}: Chromium avoids the 64 MB /dev/shm")


def test_previous_flags_kept():
    args = chromium_args(False)
    for flag in ("--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream",
                 "--mute-audio", "--enable-unsafe-swiftshader"):
        check(flag in args, f"keeps {flag}")
    check("--headless=new" not in args, "headed run has no --headless")
    check(chromium_args(True)[0] == "--headless=new", "headless run starts with --headless=new")
    check("--no-sandbox" not in chromium_args(True), "sandbox stays on")


if __name__ == "__main__":
    test_shm_flag()
    test_previous_flags_kept()
    print(f"{_passed} checks OK")
