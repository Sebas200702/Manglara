"""Checksum público de contexto: evita mezclar lecciones entre pestañas, no autentica."""
import hashlib
import hmac
import json

_FIELDS = ('issuer', 'clientId', 'deploymentId', 'courseId', 'resourceId', 'lessonCode', 'sourceVersion', 'mode')


def view_key(academic: dict) -> str:
    """Identifica material y rol sin incluir identidad ni credenciales de sesión."""
    values = [academic[field] for field in _FIELDS]
    return hashlib.sha256(json.dumps(values, separators=(',', ':')).encode()).hexdigest()


def require_view(academic: dict, expected: str | None) -> None:
    """Rechaza cookie de otro contexto antes de usar fuentes o iniciar proveedor."""
    if not isinstance(expected, str) or not hmac.compare_digest(view_key(academic), expected):
        raise ValueError('ACADEMIC_CONTEXT_CHANGED')
