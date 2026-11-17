"""Cliente del gateway: credencial de servicio nunca llega al navegador."""
import os
import re
import ssl

import httpx


COOKIE = "__Host-academia_session"


async def gateway_call(path: str, payload: dict) -> dict:
    url = os.environ["ACADEMIC_GATEWAY_URL"]
    if not url.startswith("https://"):
        raise ValueError("ACADEMIC_HTTPS_REQUIRED")
    context = ssl.create_default_context(cafile=os.getenv("ACADEMIC_CA_FILE"))
    async with httpx.AsyncClient(verify=context, timeout=10, follow_redirects=False, trust_env=False) as client:
        response = await client.post(
            url + path, json=payload,
            headers={"Authorization": "Bearer " + os.environ["ACADEMIC_SERVICE_SECRET"]},
        )
        response.raise_for_status()
        value = response.json()
        if not isinstance(value, dict):
            raise ValueError("ACADEMIC_GATEWAY_INVALID")
        return value


def valid_token(token: str | None) -> bool:
    """Comprueba formato de identificador opaco antes de consultar gateway."""
    return isinstance(token, str) and re.fullmatch(r"[a-f0-9]{64}", token) is not None
