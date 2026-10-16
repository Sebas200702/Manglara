"""Tests de detector.py. Se corren sin dependencias: `python test_detector.py`.

12 casos: 3 proveedores x link/ID + 4 de error.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from detector import (  # noqa: E402
    detect,
    normalize,
    detect_and_normalize,
    UnsupportedMeetingUrl,
)

_passed = 0


def check(name, fn):
    global _passed
    fn()
    _passed += 1
    print(f"  ok: {name}")


def must_raise(fn):
    try:
        fn()
    except UnsupportedMeetingUrl:
        return
    raise AssertionError(f"no lanzó UnsupportedMeetingUrl: {fn}")


# --- links completos ---
def t_teams_link():
    p, url = detect_and_normalize(
        "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_abc%40thread.v2/0"
    )
    assert p == "teams", p
    assert url.startswith("https://teams.microsoft.com/l/meetup-join/"), url


def t_teams_live_link():
    assert detect("https://teams.live.com/meet/123456") == "teams"


def t_zoom_link_pwd():
    p, url = detect_and_normalize("https://zoom.us/j/123456789?pwd=AbC123&foo=bar")
    assert p == "zoom", p
    assert url == "https://zoom.us/j/123456789?pwd=AbC123", url


def t_zoom_my_link():
    p, url = detect_and_normalize("https://zoom.us/my/juan.perez")
    assert p == "zoom", p
    assert url == "https://zoom.us/my/juan.perez", url


def t_meet_link():
    p, url = detect_and_normalize("https://meet.google.com/abc-defg-hij")
    assert p == "meet", p
    assert url == "https://meet.google.com/abc-defg-hij", url


# --- IDs sueltos ---
def t_zoom_id():
    assert detect_and_normalize("123456789") == (
        "zoom",
        "https://zoom.us/j/123456789",
    )


def t_meet_code_plain():
    assert detect_and_normalize("abcdefghij") == (
        "meet",
        "https://meet.google.com/abc-defg-hij",
    )


def t_meet_code_dashed():
    p, url = detect_and_normalize("abc-defg-hij")
    assert (p, url) == ("meet", "https://meet.google.com/abc-defg-hij")


# --- errores ---
def t_empty():
    must_raise(lambda: detect(""))
    must_raise(lambda: detect("   "))


def t_unknown_domain():
    must_raise(lambda: detect("https://ejemplo.com/reunion/123"))


def t_garbage():
    must_raise(lambda: detect("hola mundo"))
    must_raise(lambda: normalize("zoom", "abc"))


def t_wrong_provider():
    must_raise(
        lambda: normalize("meet", "https://zoom.us/j/123456789"),
    )
    must_raise(lambda: normalize("teams", "123456789"))


if __name__ == "__main__":
    for name, fn in sorted(
        [(k, v) for k, v in globals().items() if k.startswith("t_")]
    ):
        check(name, fn)
    print(f"\n{_passed} tests ok")
