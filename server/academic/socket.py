"""Conversación académica autorizada, con límites y limpieza de recursos."""
import asyncio
import base64
import json
import logging
import os
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from academic.curriculum import academic_prompt, lesson_source
from academic.gateway import COOKIE, gateway_call, valid_token
from academic.context_types import AcademicContext
from academic.view_context import require_view
from academic.output_gate import OutputGate, PolicyStop
from academic.reviewer import AcademicReviewer
from gemini_client import GeminiLiveClient

router = APIRouter()
logger = logging.getLogger(__name__)


@router.websocket("/academic/ws/voice")
async def voice(ws: WebSocket):
    token = ws.cookies.get(COOKIE)
    if ws.headers.get("origin") != os.environ["ACADEMIC_ORIGIN"] or not valid_token(token):
        await ws.close(code=1008)
        return
    lease = None
    gemini = None
    reviewer = None
    gate = None
    tasks = []
    accepted = False
    stage = "SESSION_UNAVAILABLE"
    started = time.monotonic()
    usage = {"durationSeconds": 0, "audioInputSeconds": 0, "audioOutputSeconds": 0, "inputCharacters": 0}
    try:
        academic = AcademicContext.model_validate(await gateway_call("/internal/session", {"token": token})).model_dump()
        require_view(academic, ws.query_params.get("view"))
        stage = "SOURCE_UNAVAILABLE"
        source = lesson_source(academic)
        stage = "CALL_UNAVAILABLE"
        lease = await gateway_call("/internal/call/claim", {"token": token})
        await ws.accept()
        accepted = True
        stage = "MODEL_UNAVAILABLE"
        # Revisión experimental solo por activación explícita del operador.
        # El piloto transmite Live directamente, sin una segunda llamada IA.
        if os.getenv("ACADEMIC_RESPONSE_REVIEW", "false") == "true":
            reviewer = AcademicReviewer(
                os.environ["GEMINI_API_KEY"],
                os.getenv("GEMINI_REVIEW_MODEL", "gemini-3.5-flash-lite"),
                academic["lessonCode"], source,
            )
            gate = OutputGate(reviewer.review, ws.send_json)
        gemini = GeminiLiveClient(
            api_key=os.environ["GEMINI_API_KEY"],
            model=os.getenv("GEMINI_LIVE_MODEL"),
            voice=os.getenv("GEMINI_VOICE_NAME"),
        )
        await asyncio.wait_for(gemini.connect(system_prompt=academic_prompt(academic, source)), timeout=20)

        async def transcript(role, text):
            await ws.send_json({"type": "transcript", "role": role, "text": text})

        async def turn_complete():
            await ws.send_json({"type": "turn_complete"})

        async def interrupted():
            await ws.send_json({"type": "interrupted"})

        gemini.transcript_callback = gate.transcript if gate else transcript
        gemini.turn_complete_callback = gate.complete if gate else turn_complete
        gemini.interrupt_callback = gate.interrupt if gate else interrupted
        await ws.send_json({"type": "session_ready"})
        last_seen = time.monotonic()

        async def incoming():
            nonlocal last_seen
            window_start, count, received_bytes = time.monotonic(), 0, 0
            async for raw in ws.iter_text():
                last_seen = time.monotonic()
                if last_seen - window_start > 5:
                    window_start, count, received_bytes = last_seen, 0, 0
                count += 1
                received_bytes += len(raw)
                if count > 300 or len(raw) > 100000 or received_bytes > 500000:
                    raise ValueError("ACADEMIC_MESSAGE_LIMIT")
                msg = json.loads(raw)
                if not isinstance(msg, dict):
                    raise ValueError("ACADEMIC_MESSAGE_INVALID")
                kind, data = msg.get("type"), msg.get("data")
                if kind == "ping":
                    continue
                if kind == "text" and isinstance(data, str) and 0 < len(data) <= 4000:
                    if gate:
                        gate.begin_text(data)
                    usage["inputCharacters"] += len(data)
                    await gemini.send_text_turn(data)
                elif kind == "audio" and isinstance(data, str):
                    pcm = base64.b64decode(data, validate=True)
                    if len(pcm) > 32000:
                        raise ValueError("ACADEMIC_AUDIO_LIMIT")
                    # Voz pausada durante generación/revisión/reproducción: no mezclar turnos.
                    if not gate or gate.accepts_input:
                        usage["audioInputSeconds"] += len(pcm) / 32000
                        await gemini.send_audio_pcm16_16k(pcm)
                else:
                    raise ValueError("ACADEMIC_MESSAGE_INVALID")

        async def outgoing():
            async for chunk in gemini.receive_loop():
                usage["audioOutputSeconds"] += len(chunk) / 48000
                if gate:
                    await gate.audio(chunk)
                else:
                    await ws.send_json({"type": "audio", "data": base64.b64encode(chunk).decode()})

        async def heartbeat():
            while True:
                await asyncio.sleep(10)
                if gate:
                    gate.check_deadline()
                if time.monotonic() - last_seen > 30:
                    raise ValueError("ACADEMIC_HEARTBEAT_EXPIRED")
                await gateway_call("/internal/call/renew", {"token": token, **lease})

        tasks = [asyncio.create_task(coro()) for coro in (incoming, outgoing, heartbeat)]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    except PolicyStop as error:
        logger.info("Academic output discarded: %s", str(error))
        if accepted:
            try:
                await ws.send_json({"type": "error", "message": str(error)})
            except Exception:
                pass
    except Exception:
        logger.warning("Academic connection failed: %s", stage)
        if accepted:
            try:
                await ws.send_json({"type": "error", "message": "Tutoría no disponible. Código: " + stage})
            except Exception:
                pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if gate:
            gate.close()
        if reviewer:
            try:
                await asyncio.wait_for(reviewer.close(), timeout=3)
            except Exception:
                pass
        if gemini:
            try:
                await asyncio.wait_for(gemini.close(), timeout=5)
            except Exception:
                pass
        if lease:
            try:
                usage["durationSeconds"] = time.monotonic() - started
                await gateway_call("/internal/call/release", {"token": token, **lease, "usage": usage})
            except Exception:
                pass
        try:
            await ws.close(code=1000)
        except Exception:
            pass
