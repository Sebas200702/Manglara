import asyncio
import base64
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import (
    CORS_ALLOW_ORIGINS,
    LOG_TRANSCRIPTS,
    MEETING_WEB_URL,
    MEETINGS_ENABLED,
    PORT,
    VOICE_ALLOWED_ORIGINS,
    VOICE_MAX_SESSIONS,
    VOICE_IDLE_TIMEOUT_S,
    VOICE_MAX_NEW_SESSIONS_PER_MIN,
    VOICE_MAX_SESSION_MIN,
    VOICE_MAX_SESSIONS_PER_IP,
)
from db import list_active_documents
from gemini_client import GeminiLiveClient
from knowledge.router import auth_router, router as knowledge_router
from meeting.router import router as meeting_router, ws_router as meeting_ws_router
from pdf.digest import build_knowledge_context
from pdf.retrieval import retrieve_context
from pdf.router import router as pdf_router
from prompt import CONTEXT_NOTE, LANGUAGE_REMINDER, build_system_prompt
from voice_admission import BUSY_MESSAGE, ORIGIN_MESSAGE, VoiceAdmission
from voice_watchdog import SessionWatchdog

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("server")

# Eager RAG: fire retrieval while the user is still speaking so the context
# reaches Gemini before it starts answering.
RAG_MIN_CHARS = 40  # partial transcript length that triggers retrieval at once
RAG_DEBOUNCE_S = 0.3  # for shorter partials, wait for a pause in the stream
# Cada cuántos turnos se le recuerda que responda en el idioma de la persona.
LANG_REMIND_EVERY = 4


@asynccontextmanager
async def lifespan(app: FastAPI):
    # La fuente de verdad del conocimiento es la BD (documents.active,
    # “/{doc_id}” en el panel del gestor). Ya no hay lista en memoria que
    # activar al arrancar: cada sesión de voz lee el estado fresco.
    try:
        docs = await list_active_documents()
        logger.info("[startup] conocimiento activo: %d fuentes", len(docs))
    except Exception as e:
        logger.error(f"[startup] no se pudo leer el conocimiento activo: {e}")
    yield


app = FastAPI(lifespan=lifespan)

cors_origins = ["http://localhost:5173", "http://127.0.0.1:5173", *CORS_ALLOW_ORIGINS]
if MEETING_WEB_URL and MEETING_WEB_URL not in cors_origins:
    cors_origins.append(MEETING_WEB_URL)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(knowledge_router)
app.include_router(pdf_router)
if MEETINGS_ENABLED:
    app.include_router(meeting_router)
    app.include_router(meeting_ws_router)
else:
    logger.info("[startup] API de reuniones desactivada (MEETINGS_ENABLED=false)")

voice_admission = VoiceAdmission(
    max_sessions=VOICE_MAX_SESSIONS,
    max_per_ip=VOICE_MAX_SESSIONS_PER_IP,
    max_new_per_min=VOICE_MAX_NEW_SESSIONS_PER_MIN,
    allowed_origins=VOICE_ALLOWED_ORIGINS,
)


@app.get("/health")
async def health():
    return {"ok": True}


CONNECT_FAILED_MESSAGE = "No pude conectar con Manglara. Intenta de nuevo en un momento."


def _connect_error_message(error: Exception) -> str:
    """User-facing text for a failed Gemini connect. Quota exhaustion reads as
    "busy" (it clears in a minute); raw provider errors never reach the user."""
    text = str(error).lower()
    if "quota" in text or "resource has been exhausted" in text or "resource_exhausted" in text:
        return BUSY_MESSAGE
    return CONNECT_FAILED_MESSAGE


async def _reject(ws: WebSocket, message: str):
    await ws.send_json({"type": "error", "message": message})
    await ws.close()


@app.websocket("/ws/voice")
async def ws_voice(ws: WebSocket):
    await ws.accept()

    if not voice_admission.origin_allowed(ws.headers.get("origin")):
        logger.warning("[ws] origin rejected: %s", ws.headers.get("origin"))
        await _reject(ws, ORIGIN_MESSAGE)
        return

    ip = ws.client.host if ws.client else ""
    reason = voice_admission.try_acquire(ip)
    if reason:
        logger.warning("[ws] voice session rejected (active=%d)", voice_admission.active)
        await _reject(ws, reason)
        return

    try:
        await _voice_session(ws)
    finally:
        voice_admission.release(ip)


async def _voice_session(ws: WebSocket):
    logger.info("[ws] Client connected (active=%d)", voice_admission.active)

    gemini = GeminiLiveClient()
    gemini.log_transcripts = LOG_TRANSCRIPTS

    try:
        active = await list_active_documents()
        active_ids = [d["id"] for d in active]
        knowledge = await build_knowledge_context(active_ids)
        if knowledge:
            logger.info("[ws] preloading %d chars of knowledge (%d fuentes activas)",
                        len(knowledge), len(active_ids))
        else:
            logger.warning(
                "[ws] no knowledge to preload (%d active docs); relying on retrieval only",
                len(active_ids),
            )
    except Exception as e:
        logger.warning(f"[ws] knowledge preload failed: {e}")
        knowledge = ""

    try:
        # Without compression Gemini Live ends audio+video sessions after about
        # two minutes and every reconnect pays the whole system prompt again;
        # the sliding window keeps one session alive (same as the meeting bot).
        await gemini.connect(
            system_prompt=build_system_prompt(knowledge),
            extra_config={"context_window_compression": {"sliding_window": {}}},
        )
    except Exception as e:
        logger.error(f"[ws] Gemini connect failed: {e}")
        await ws.send_json({"type": "error", "message": _connect_error_message(e)})
        await ws.close()
        return

    try:
        await ws.send_json({"type": "session_ready"})
    except Exception:
        # The browser left while Gemini was connecting: do not leave the
        # Gemini session open.
        await gemini.close()
        return

    watchdog = SessionWatchdog(
        idle_s=VOICE_IDLE_TIMEOUT_S, max_s=VOICE_MAX_SESSION_MIN * 60
    )

    async def on_transcript(role: str, text: str):
        # Both sides count as activity: a long answer must not be cut.
        watchdog.touch()
        await ws.send_json({"type": "transcript", "role": role, "text": text})

    async def on_turn_complete():
        watchdog.touch()
        await ws.send_json({"type": "turn_complete"})

    async def on_interrupted():
        await ws.send_json({"type": "interrupted"})

    rag = {"fired": False, "debounce": None}
    # Refuerzo del idioma: el modelo detecta el idioma de la persona (no hay
    # lista de idiomas en Python: la detecta el modelo, que es mucho mejor),
    # pero el prompt y las cartillas están en español y, con el contexto
    # creciendo, se le olvida. Se le recuerda cada pocos turnos, ya con la
    # persona hablando para que el recordatorio no dispare una respuesta.
    lang = {"turn": 0, "sent": False}

    async def remind_language():
        await gemini.inject_context(LANGUAGE_REMINDER)
        logger.info("[lang] recordatorio de idioma inyectado")

    async def run_retrieval(text: str):
        try:
            active = await list_active_documents()
            doc_ids = [d["id"] for d in active]
            if not doc_ids:
                return
            context = await retrieve_context(doc_ids, text)
            if context:
                await gemini.inject_context(CONTEXT_NOTE + "\n\n" + context)
                logger.info("[rag] injected %d chars of context", len(context))
        except Exception as e:
            logger.warning("[rag] retrieval failed: %s", e)

    def cancel_debounce():
        if rag["debounce"] and not rag["debounce"].done():
            rag["debounce"].cancel()
        rag["debounce"] = None

    async def on_user_partial(text: str):
        watchdog.touch()
        if not lang["sent"] and lang["turn"] % LANG_REMIND_EVERY == 0:
            lang["sent"] = True
            asyncio.create_task(remind_language())
        if rag["fired"]:
            return
        cancel_debounce()
        if len(text.strip()) >= RAG_MIN_CHARS:
            rag["fired"] = True
            asyncio.create_task(run_retrieval(text))
        else:

            async def debounced(snapshot: str):
                await asyncio.sleep(RAG_DEBOUNCE_S)
                rag["fired"] = True
                # Spawn separately: only the wait is cancellable, never an
                # in-flight retrieval.
                asyncio.create_task(run_retrieval(snapshot))

            rag["debounce"] = asyncio.create_task(debounced(text))

    async def on_user_turn(text: str):
        # The model already started answering. If retrieval never fired during
        # speech (transcription arrived too late), run it now so at least the
        # follow-up turn has the context. Reset state for the next turn.
        cancel_debounce()
        fired = rag["fired"]
        rag["fired"] = False
        lang["turn"] += 1
        lang["sent"] = False
        if not fired and text.strip():
            asyncio.create_task(run_retrieval(text))

    gemini.transcript_callback = on_transcript
    gemini.turn_complete_callback = on_turn_complete
    gemini.interrupt_callback = on_interrupted
    gemini.on_user_turn_complete = on_user_turn
    gemini.on_user_partial_transcript = on_user_partial

    async def ws_to_gemini():
        try:
            async for raw in ws.iter_text():
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await ws.send_json({"type": "error", "message": "Invalid JSON"})
                    continue

                msg_type = msg.get("type")
                data = msg.get("data", "")
                
                if not data:
                    continue

                if msg_type == "audio":
                    pcm = base64.b64decode(data)
                    logger.debug("[ws] audio chunk received (%d bytes)", len(pcm))
                    await gemini.send_audio_pcm16_16k(pcm)
                elif msg_type == "video":
                    image_bytes = base64.b64decode(data)
                    await gemini.send_image_jpeg(image_bytes)
                    logger.debug(f"[ws] Video frame sent ({len(image_bytes)} bytes)")
        except WebSocketDisconnect:
            logger.info("[ws] Client disconnected")
        except Exception as e:
            logger.error(f"[ws] Error in ws_to_gemini: {e}")

    async def gemini_to_ws():
        try:
            async for audio_chunk in gemini.receive_loop():
                b64 = base64.b64encode(audio_chunk).decode()
                await ws.send_json({"type": "audio", "data": b64})
        except Exception as e:
            logger.error(f"[gemini] Error in gemini_to_ws: {e}")

    # Whichever side ends first ends the session. With gather, a browser that
    # disconnected left gemini_to_ws blocked in receive() and the Gemini
    # session (quota) alive until Gemini itself closed it.
    async def end_when_unused():
        message = await watchdog.wait()
        logger.info("[ws] ending unused session: %s", message)
        # The client shows the message and does not auto-reconnect.
        await ws.send_json({"type": "session_ended", "message": message})

    tasks = [
        asyncio.create_task(ws_to_gemini()),
        asyncio.create_task(gemini_to_ws()),
        asyncio.create_task(end_when_unused()),
    ]
    try:
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    except Exception as e:
        logger.error(f"[ws] Session error: {e}")
    finally:
        for task in tasks:
            task.cancel()
        await gemini.close()
        try:
            await ws.close()
        except Exception:
            pass  # already closed by the client
        logger.info("[ws] Connection closed")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, log_level="info")
