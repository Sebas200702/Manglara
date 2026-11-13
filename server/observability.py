"""Error tracking via Rustrak (Sentry-compatible ingest).

Off unless SENTRY_DSN is set. Never sends PII or local variables: frames of
the voice pipeline hold user transcripts and audio.
"""

import logging
import os
from collections.abc import Mapping

import sentry_sdk

logger = logging.getLogger(__name__)


def init_error_tracking(env: Mapping[str, str] = os.environ) -> bool:
    dsn = env.get("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    sentry_sdk.init(
        dsn=dsn,
        environment=env.get("SENTRY_ENVIRONMENT") or "production",
        release=env.get("SENTRY_RELEASE") or None,
        send_default_pii=False,
        include_local_variables=False,
        traces_sample_rate=float(env.get("SENTRY_TRACES_SAMPLE_RATE") or 0),
    )
    logger.info("Error tracking enabled")
    return True
