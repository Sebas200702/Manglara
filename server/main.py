import asyncio
import base64
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import PORT
from gemini_client import GeminiLiveClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("server")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"ok": True}


@app.websocket("/ws/voice")
async def ws_voice(ws: WebSocket):
    await ws.accept()
    logger.info("[ws] Client connected")

    gemini = GeminiLiveClient()

    try:
        await gemini.connect()
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

    gemini.transcript_callback = on_transcript
    gemini.turn_complete_callback = on_turn_complete

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
