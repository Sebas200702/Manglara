import asyncio
import base64
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import PORT
from db import list_documents
from gemini_client import GeminiLiveClient
from pdf.digest import backfill_digests, build_knowledge_context
from pdf.router import router as pdf_router, get_active_documents, set_active_documents
from pdf.retrieval import retrieve_context
from pdf.sources import ready_curriculum_document_ids
from prompt import build_system_prompt

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

async def activate_ready_documents():
    # Active docs live in memory, so every restart must re-activate them;
    # otherwise sessions run without any knowledge source.
    try:
        docs = await list_documents()
        ready = ready_curriculum_document_ids(docs)
        set_active_documents(ready)
        logger.info("[startup] activated %d ready documents", len(ready))
        if ready:
            asyncio.create_task(backfill_digests(ready))
    except Exception as e:
        logger.error(f"[startup] document activation failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await activate_ready_documents()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(pdf_router)


@app.get("/health")
async def health():
    return {"ok": True}


@app.websocket("/ws/voice")
async def ws_voice(ws: WebSocket):
    await ws.accept()
    logger.info("[ws] Client connected")

    gemini = GeminiLiveClient()

    try:
        knowledge = await build_knowledge_context(get_active_documents())
        if knowledge:
            logger.info("[ws] preloading %d chars of knowledge", len(knowledge))
        else:
            logger.warning(
                "[ws] no knowledge to preload (%d active docs); relying on retrieval only",
                len(get_active_documents()),
            )
    except Exception as e:
        logger.warning(f"[ws] knowledge preload failed: {e}")
        knowledge = ""

    try:
        await gemini.connect(system_prompt=build_system_prompt(knowledge))
    except Exception as e:
        logger.error(f"[ws] Gemini connect failed: {e}")
        await ws.send_json({"type": "error", "message": str(e)})
        await ws.close()
        return

    await ws.send_json({"type": "session_ready"})

    async def on_transcript(role: str, text: str):
        await ws.send_json({"type": "transcript", "role": role, "text": text})

    async def on_turn_complete():
        await ws.send_json({"type": "turn_complete"})

    async def on_interrupted():
        await ws.send_json({"type": "interrupted"})

    rag = {"fired": False, "debounce": None}

    async def run_retrieval(text: str):
        doc_ids = get_active_documents()
        if not doc_ids:
            return
        try:
            context = await retrieve_context(doc_ids, text)
            if context:
                await gemini.inject_context(
                    "[Contexto recuperado automáticamente de las cartillas del "
                    "Currículo Verde; el usuario no escribió esto. Úsalo para "
                    f"responder.]\n\n{context}"
                )
                logger.info("[rag] injected %d chars of context", len(context))
        except Exception as e:
            logger.warning("[rag] retrieval failed: %s", e)

    def cancel_debounce():
        if rag["debounce"] and not rag["debounce"].done():
            rag["debounce"].cancel()
        rag["debounce"] = None

    async def on_user_partial(text: str):
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

    try:
        await asyncio.gather(ws_to_gemini(), gemini_to_ws())
    except Exception as e:
        logger.error(f"[ws] Session error: {e}")
    finally:
        await gemini.close()
        logger.info("[ws] Connection closed")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, log_level="info")
