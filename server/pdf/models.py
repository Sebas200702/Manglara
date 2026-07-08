from pydantic import BaseModel
from datetime import datetime


class DocumentOut(BaseModel):
    id: str
    name: str
    page_count: int | None = None
    status: str
    file_uri: str | None = None
    created_at: datetime | None = None


class IngestResponse(BaseModel):
    document_id: str
    status: str
    chunks_count: int
    pages: int


class ActivateResponse(BaseModel):
    document_id: str
    message: str
