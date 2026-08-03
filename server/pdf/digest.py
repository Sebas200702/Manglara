import logging

from google import genai

from config import GEMINI_API_KEY, GEMINI_DIGEST_MODEL
from db import get_document_chunks, list_documents, update_document_digest

logger = logging.getLogger(__name__)

# Digests get preloaded into the Live session's system prompt, so the total
# budget matters more than per-document size: keep it a few thousand tokens.
MAX_SOURCE_CHARS = 250_000
MAX_KNOWLEDGE_CHARS = 60_000

DIGEST_INSTRUCTIONS = (
    "A continuación está el texto completo del documento '{name}', parte de las "
    "cartillas del currículo 'Habilidades Verdes para la Vida'.\n\n"
    "Genera un digesto de conocimiento en español: un resumen denso y fiel que preserve:\n"
    "- La estructura del documento (módulos, lecciones, secciones)\n"
    "- Definiciones, conceptos clave y mensajes centrales\n"
    "- Datos concretos: cifras, porcentajes, fechas y nombres propios\n"
    "- Ejemplos y actividades representativos\n\n"
    "No agregues información que no esté en el texto ni opiniones propias. "
    "Empieza directamente con el contenido, sin preámbulos ni frases introductorias. "
    "Escribe en prosa compacta con subtítulos. Longitud objetivo: 3000 a 8000 caracteres.\n\n"
    "TEXTO DEL DOCUMENTO:\n{text}"
)


# The preferred model can hit 503 (high demand) at any time; digesting is an
# offline task, so quality differences between these are acceptable.
_FALLBACK_MODELS = ["models/gemini-3.1-flash-lite", "models/gemini-2.5-flash"]


async def generate_digest(genai_client, name: str, full_text: str) -> str | None:
    prompt = DIGEST_INSTRUCTIONS.format(name=name, text=full_text[:MAX_SOURCE_CHARS])
    models = [GEMINI_DIGEST_MODEL] + [
        m for m in _FALLBACK_MODELS if m != GEMINI_DIGEST_MODEL
    ]
    for model in models:
        try:
            resp = await genai_client.aio.models.generate_content(
                model=model, contents=prompt
            )
            digest = (resp.text or "").strip()
            if digest:
                return digest
        except Exception as e:
            logger.warning(
                "[digest] %s failed for '%s': %s", model, name, str(e)[:200]
            )
    return None


async def backfill_digests(doc_ids: list[str]):
    """Generate and persist digests for documents ingested before digests existed."""
    docs = await list_documents()
    if docs and "digest" not in docs[0]:
        logger.error(
            "[digest] documents table has no 'digest' column; "
            "run migrations/003_document_digest.sql in Supabase first"
        )
        return
    missing = [
        d
        for d in docs
        if d["id"] in doc_ids and d["status"] == "ready" and not d.get("digest")
    ]
    if not missing:
        return
    logger.info("[digest] backfilling %d documents without digest", len(missing))
    client = genai.Client(api_key=GEMINI_API_KEY)
    for doc in missing:
        try:
            chunks = await get_document_chunks(doc["id"])
            # Chunks carry overlap words; harmless redundancy for digesting.
            full_text = "\n\n".join(c["content"] for c in chunks)
            if not full_text.strip():
                continue
            digest = await generate_digest(client, doc["name"], full_text)
            if digest:
                await update_document_digest(doc["id"], digest)
                logger.info(
                    "[digest] backfilled '%s' (%d chars)", doc["name"], len(digest)
                )
        except Exception as e:
            logger.warning("[digest] backfill failed for '%s': %s", doc["name"], e)


async def build_knowledge_context(doc_ids: list[str]) -> str:
    """Concatenate stored digests of the active documents, capped to fit the system prompt."""
    if not doc_ids:
        logger.warning("[digest] no active documents to build knowledge from")
        return ""
    docs = await list_documents()
    by_id = {d["id"]: d for d in docs}
    parts: list[str] = []
    total = 0
    for doc_id in doc_ids:
        doc = by_id.get(doc_id)
        if not doc:
            continue
        digest = (doc.get("digest") or "").strip()
        if not digest:
            logger.warning(
                "[digest] active document '%s' has no digest yet; "
                "only retrieval will cover it",
                doc["name"],
            )
            continue
        entry = f"### {doc['name']}\n{digest}"
        if total + len(entry) > MAX_KNOWLEDGE_CHARS:
            logger.warning(
                "[digest] knowledge budget (%d chars) exceeded; skipping '%s' "
                "from the preload",
                MAX_KNOWLEDGE_CHARS,
                doc["name"],
            )
            continue
        parts.append(entry)
        total += len(entry)
    return "\n\n".join(parts)
