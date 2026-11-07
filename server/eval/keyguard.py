"""Guard that keeps the eval off the production Gemini key.

The production key's Live quota is tiny (a handful of sessions per minute
exhausts it and takes the public assistant down), so the eval only runs with
a separate key in `EVAL_GEMINI_API_KEY`, and that key replaces
`GEMINI_API_KEY` for the whole process before any server module reads it.
"""

import os
import sys

from dotenv import dotenv_values

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Same lookup as config.py, so a key that only lives in .env is also caught.
DEFAULT_ENV_FILES = [
    os.path.join(_SERVER_DIR, "..", ".env"),
    os.path.join(os.getcwd(), ".env"),
    os.path.join(os.getcwd(), "..", ".env"),
]

MISSING_MESSAGE = (
    "Refusing to run: set EVAL_GEMINI_API_KEY to a Gemini key that is NOT the "
    "production key. Each case opens a Live session; running on the production "
    "key exhausts its quota and takes the public assistant down."
)
SAME_MESSAGE = (
    "Refusing to run: EVAL_GEMINI_API_KEY is the production GEMINI_API_KEY. "
    "Use a separate key for the eval."
)


class EvalKeyError(RuntimeError):
    pass


def _production_keys(env, env_files) -> set[str]:
    keys = {(env.get("GEMINI_API_KEY") or "").strip()}
    for path in env_files:
        if os.path.exists(path):
            keys.add((dotenv_values(path).get("GEMINI_API_KEY") or "").strip())
    keys.discard("")
    return keys


def resolve_eval_key(env=None, env_files=None) -> str:
    env = os.environ if env is None else env
    env_files = DEFAULT_ENV_FILES if env_files is None else env_files
    key = (env.get("EVAL_GEMINI_API_KEY") or "").strip()
    if not key:
        raise EvalKeyError(MISSING_MESSAGE)
    if key in _production_keys(env, env_files):
        raise EvalKeyError(SAME_MESSAGE)
    return key


def apply_eval_key(key: str) -> None:
    """Make every Gemini client in this process use the eval key.

    Setting the env before `config` is imported is enough (load_dotenv does
    not override it); modules already imported are patched as well.
    """
    os.environ["GEMINI_API_KEY"] = key
    for name in ("config", "gemini_client", "pdf.digest"):
        mod = sys.modules.get(name)
        if mod is not None and hasattr(mod, "GEMINI_API_KEY"):
            mod.GEMINI_API_KEY = key
