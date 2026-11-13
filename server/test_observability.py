"""Tests of error tracking setup (Rustrak, Sentry-compatible).

Run from `server/`: `python -m test_observability`. No network: the DSN
points at a dummy host and nothing is captured.
"""

import sentry_sdk

from observability import init_error_tracking

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


def _reset():
    sentry_sdk.get_global_scope().set_client(None)


def test_disabled_without_dsn():
    _reset()
    check(init_error_tracking({}) is False, "no SENTRY_DSN: tracking stays off")
    check(not sentry_sdk.get_client().is_active(), "no SENTRY_DSN: no active client")


def test_enabled_with_dsn():
    _reset()
    env = {
        "SENTRY_DSN": "https://abc@errors.example.invalid/3",
        "SENTRY_ENVIRONMENT": "preview",
        "SENTRY_RELEASE": "manglara-server@test",
    }
    check(init_error_tracking(env) is True, "SENTRY_DSN set: tracking on")
    client = sentry_sdk.get_client()
    check(client.is_active(), "SENTRY_DSN set: client active")
    opts = client.options
    check(opts["environment"] == "preview", "environment from SENTRY_ENVIRONMENT")
    check(opts["release"] == "manglara-server@test", "release from SENTRY_RELEASE")
    check(opts["send_default_pii"] is False, "no PII sent")
    check(opts["include_local_variables"] is False, "no local variables (transcripts) sent")
    check(opts["traces_sample_rate"] == 0.0, "tracing off by default")
    _reset()


def test_traces_rate_from_env():
    _reset()
    env = {"SENTRY_DSN": "https://abc@errors.example.invalid/3", "SENTRY_TRACES_SAMPLE_RATE": "0.2"}
    init_error_tracking(env)
    check(sentry_sdk.get_client().options["traces_sample_rate"] == 0.2, "traces rate from env")
    _reset()


if __name__ == "__main__":
    test_disabled_without_dsn()
    test_enabled_with_dsn()
    test_traces_rate_from_env()
    print(f"{_passed} checks OK")
