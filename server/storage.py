import httpx
import logging

logger = logging.getLogger(__name__)


class StorageClient:
    def __init__(self, supabase_url: str, service_key: str, bucket: str):
        self._base = f"{supabase_url}/storage/v1/object/{bucket}"
        self._headers = {
            "Authorization": f"Bearer {service_key}",
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
