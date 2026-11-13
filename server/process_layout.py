"""Guard for running the API with several uvicorn workers.

The voice API scales across workers/replicas. The meeting bot does not: each
meeting lives in one process (Chromium page, Gemini session, SESSIONS dict),
so with several workers its REST calls and WebSockets land on processes that
do not know the meeting. Instances that scale must turn meetings off; one
instance with a single worker keeps serving them.
"""

from collections.abc import Mapping

MEETINGS_MULTI_WORKER_ERROR = (
    "El bot de reuniones necesita un solo worker: usa WEB_CONCURRENCY=1 en esta "
    "instancia o MEETINGS_ENABLED=false en las instancias que escalan."
)


def workers_from_env(env: Mapping[str, str]) -> int:
    """Workers uvicorn will start: it reads $WEB_CONCURRENCY when --workers is absent."""
    return int(env.get("WEB_CONCURRENCY") or 1)


def layout_error(workers: int, meetings_enabled: bool) -> str | None:
    if workers > 1 and meetings_enabled:
        return MEETINGS_MULTI_WORKER_ERROR
    return None
