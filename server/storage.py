import httpx
import logging
import re
import unicodedata
import uuid

logger = logging.getLogger(__name__)


def storage_key(filename: str) -> str:
    """ASCII-only object name for Supabase Storage, which rejects keys with
    accents ('término', 'AÑO') with a 400. The original filename stays in the
    documents row; this only names the stored blob."""
    ascii_name = (
        unicodedata.normalize("NFKD", filename).encode("ascii", "ignore").decode()
    )
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", ascii_name).strip("_")
    return f"{uuid.uuid4()}/{ascii_name or 'document'}"


class StorageClient:
    def __init__(self, supabase_url: str, service_key: str, bucket: str):
        self._base = f"{supabase_url}/storage/v1/object/{bucket}"
        self._root = supabase_url
        self._headers = {
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
        }
        self._bucket = bucket

    async def upload(
        self, path: str, data: bytes, content_type: str | None = None
    ) -> str:
        if not content_type:
            ext = path.rsplit(".", 1)[-1].lower()
            content_type = {
                "pdf": "application/pdf",
                "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }.get(ext, "application/octet-stream")
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._base}/{path}",
                headers={**self._headers, "Content-Type": content_type},
                content=data,
            )
            resp.raise_for_status()
            logger.info("[storage] uploaded %s", path)
        return path

    async def get_public_url(self, path: str) -> str:
        base = self._base.rsplit("/object", 1)[0]
        return f"{base}/object/public/{self._bucket}/{path}"

    async def delete(self, path: str):
        async with httpx.AsyncClient() as client:
            resp = await client.delete(
                f"{self._base}/{path}",
                headers=self._headers,
            )
            resp.raise_for_status()
            logger.info("[storage] deleted %s", path)

    async def create_signed_upload_url(self, path: str) -> str:
        """URL firmada para que el navegador suba el archivo DIRECTO a
        Supabase y nunca pase por Vercel (cuerpo máx. 4.5 MB)."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self._root}/storage/v1/object/upload/sign/{self._bucket}/{path}",
                headers=self._headers,
            )
            resp.raise_for_status()
            data = resp.json()
            signed = data.get("signed_url") or data.get("url")
            if not signed:
                raise RuntimeError("Supabase no devolvió una URL de subida firmada")
        return f"{self._root}/storage/v1{signed}"

    async def download(self, path: str) -> bytes:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{self._base}/{path}", headers=self._headers)
            resp.raise_for_status()
            return resp.content

    def download_sync(self, path: str) -> bytes:
        """Para correr en un thread (asyncio.to_thread) sin bloquear el loop."""
        return httpx.get(f"{self._base}/{path}", headers=self._headers).content
