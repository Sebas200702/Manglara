"""Servidor dedicado a academia; no expone APIs/documentos del evento."""
import logging

from fastapi import FastAPI
from academic.routes import router as http_router
from academic.socket import router as socket_router

# Cliente compartido registra transcripciones a INFO en modo evento. Este proceso
# académico las excluye; el otro servidor conserva comportamiento independiente.
logging.getLogger("gemini_client").setLevel(logging.WARNING)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(http_router)
app.include_router(socket_router)


@app.get("/academic/api/health")
async def health():
    return {"ok": True, "mode": "academic"}
