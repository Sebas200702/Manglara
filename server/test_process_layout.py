"""Tests of the worker/meetings layout guard.

Run from `server/`: `python -m test_process_layout`.
"""

from process_layout import MEETINGS_MULTI_WORKER_ERROR, layout_error

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


def test_layout():
    check(layout_error(1, True) is None, "1 worker with meetings: ok (previous default)")
    check(layout_error(4, False) is None, "4 workers voice-only: ok")
    check(layout_error(2, True) == MEETINGS_MULTI_WORKER_ERROR, "2 workers with meetings: refused")
    check("MEETINGS_ENABLED=false" in MEETINGS_MULTI_WORKER_ERROR, "error says how to fix it")


def test_workers_from_env():
    from process_layout import workers_from_env
    check(workers_from_env({}) == 1, "no WEB_CONCURRENCY: 1 worker")
    check(workers_from_env({"WEB_CONCURRENCY": "3"}) == 3, "WEB_CONCURRENCY=3: 3 workers")
    check(workers_from_env({"WEB_CONCURRENCY": ""}) == 1, "empty WEB_CONCURRENCY: 1 worker")


if __name__ == "__main__":
    test_layout()
    test_workers_from_env()
    print(f"{_passed} checks OK")
