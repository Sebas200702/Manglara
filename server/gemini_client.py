import asyncio
import logging
from typing import AsyncIterator, Callable, Any

from google import genai
from google.genai import types

from config import (
    GEMINI_API_KEY,
    GEMINI_LIVE_MODEL,
    GEMINI_MEDIA_RESOLUTION,
    GEMINI_TEMPERATURE,
    GEMINI_VOICE_NAME,
)
from prompt import SYSTEM_PROMPT

logger = logging.getLogger(__name__)


def live_config(system_prompt: str | None = None, extra_config: dict | None = None) -> dict:
    """Gemini Live session config. Optional settings are only sent when set,
    so an unset env var keeps the model default."""
    return {
        "response_modalities": ["AUDIO"],
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "speech_config": {
            "voice_config": {
                "prebuilt_voice_config": {
                    "voice_name": GEMINI_VOICE_NAME,
                }
            }
        },
        "system_instruction": {
            "parts": [{"text": system_prompt or SYSTEM_PROMPT}]
        },
        **(
            {"media_resolution": GEMINI_MEDIA_RESOLUTION}
            if GEMINI_MEDIA_RESOLUTION
            else {}
        ),
        **({"temperature": GEMINI_TEMPERATURE} if GEMINI_TEMPERATURE is not None else {}),
        **(extra_config or {}),
    }


class GeminiLiveClient:
    def __init__(self):
        self.client = genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=GEMINI_API_KEY,
        )
        self._ctx = None
        self.session = None
        self.transcript_callback: Callable[[str, str], Any] | None = None
        self.turn_complete_callback: Callable[[], Any] | None = None
        self.interrupt_callback: Callable[[], Any] | None = None
        self.on_user_turn_complete: Callable[[str], Any] | None = None
        self.on_user_partial_transcript: Callable[[str], Any] | None = None
        self._user_text_buffer = ""
        self._receiving_output = False
        # Off for meetings: third parties speak there, so their words (and
        # Manglara's answers) stay out of the server logs.
        self.log_transcripts = True
        # Latest session-resumption handle (only sent when the config asks for
        # `session_resumption`): reconnecting with it keeps the conversation.
        self.resumption_handle: str | None = None
        # Set when Gemini announced the end of this connection (Live session
        # duration limit). receive_loop then returns so the caller can
        # reconnect before Gemini aborts the socket with 1008.
        self.go_away_received = False

    async def connect(
        self, system_prompt: str | None = None, extra_config: dict | None = None
    ):
        config = live_config(system_prompt, extra_config)

        ctx = self.client.aio.live.connect(
            model=GEMINI_LIVE_MODEL, config=config
        )
        self.session = await ctx.__aenter__()
        self._ctx = ctx
        self.go_away_received = False
        self._user_text_buffer = ""
        self._receiving_output = False
        logger.info("[gemini] session opened")

    async def reconnect(
        self, system_prompt: str | None = None, extra_config: dict | None = None
    ):
        """Replace the connection after go_away. The latest resumption handle
        keeps the conversation; a rejected or missing handle opens a fresh
        session. `extra_config` must ask for `session_resumption`."""
        handle = self.resumption_handle
        try:
            await self.close()
        except Exception as e:
            # Gemini may have dropped the old socket already.
            logger.debug("[gemini] close before reconnect: %s", e)
            self._ctx = None
            self.session = None
        config = dict(extra_config or {})
        if handle:
            try:
                await self.connect(
                    system_prompt,
                    {**config, "session_resumption": {"handle": handle}},
                )
                logger.info("[gemini] session resumed")
                return
            except Exception as e:
                logger.warning("[gemini] resumption failed, fresh session: %s", e)
        self.resumption_handle = None
        await self.connect(system_prompt, {**config, "session_resumption": {}})

    async def close(self):
        if self._ctx:
            await self._ctx.__aexit__(None, None, None)
            self._ctx = None
            self.session = None
            logger.info("[gemini] session closed")

    async def send_audio_pcm16_16k(self, pcm: bytes):
        if not self.session:
            logger.warning("[gemini] no session, dropping audio (%d bytes)", len(pcm))
            return
        logger.debug("[gemini] sending %d bytes to live API", len(pcm))
        await self.session.send_realtime_input(
            audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000")
        )

    async def send_image_jpeg(self, image_data: bytes):
        if not self.session:
            return
        await self.session.send_realtime_input(
            video=types.Blob(data=image_data, mime_type="image/jpeg")
        )

    async def inject_context(self, text: str):
        if not self.session:
            return
        # Incremental content update: appends to the conversation without
        # closing the turn, so it can land while the user is still speaking.
        await self.session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part(text=text)]),
            turn_complete=False,
        )

    async def send_text(self, text: str):
        """Complete user turn from text: the model answers it right away."""
        if not self.session:
            return
        await self.session.send_client_content(
            turns=types.Content(role="user", parts=[types.Part(text=text)]),
            turn_complete=True,
        )

    async def receive_loop(self) -> AsyncIterator[bytes]:
        while True:
            async for response in self.session.receive():
                logger.debug("[gemini] response type: server_content=%s data=%s setup_complete=%s",
                    "yes" if response.server_content else "no",
                    "yes" if response.data else "no",
                    "yes" if response.setup_complete else "no",
                )

                upd = getattr(response, "session_resumption_update", None)
                if upd and getattr(upd, "resumable", False) and upd.new_handle:
                    self.resumption_handle = upd.new_handle

                go_away = getattr(response, "go_away", None)
                if go_away:
                    logger.info("[gemini] go_away (time_left=%s)", go_away.time_left)
                    self.go_away_received = True
                    return

                sc = response.server_content

                if sc:
                    # Partial (interim) transcription — user is still speaking
                    interim = getattr(sc, "interim_input_transcription", None)
                    if interim and getattr(interim, "text", None):
                        if self.on_user_partial_transcript:
                            await self.on_user_partial_transcript(
                                self._user_text_buffer + interim.text
                            )

                    # Final transcription for a segment of user speech
                    final = getattr(sc, "input_transcription", None)
                    if final and getattr(final, "text", None):
                        self._user_text_buffer += final.text
                        self._receiving_output = False
                        if self.transcript_callback:
                            await self.transcript_callback("user", final.text)
                        if self.on_user_partial_transcript:
                            await self.on_user_partial_transcript(
                                self._user_text_buffer
                            )
                        if self.log_transcripts:
                            logger.info("[gemini] user transcript: %s", final.text[:100])

                    # Model transcription (what Gemini is saying)
                    if getattr(sc, "output_transcription", None):
                        text = getattr(sc.output_transcription, "text", None)
                        if not self._receiving_output and self._user_text_buffer.strip():
                            user_text = self._user_text_buffer
                            self._user_text_buffer = ""
                            if self.on_user_turn_complete:
                                asyncio.create_task(self.on_user_turn_complete(user_text))
                        self._receiving_output = True
                        if text:
                            if self.transcript_callback:
                                await self.transcript_callback("model", text)
                            if self.log_transcripts:
                                logger.info("[gemini] model transcript: %s", text[:100])

                    # Barge-in: the user spoke over Manglara, so Gemini abandoned
                    # the rest of this turn. Everything already sent downstream is
                    # now stale and MUST be dropped: Gemini streams audio far
                    # ahead of playback, so without this the client keeps playing
                    # cancelled audio while the avatar mouths its transcript, and
                    # the two clocks never resync for the rest of the session.
                    if getattr(sc, "interrupted", False):
                        logger.info("[gemini] interrupted by user")
                        self._receiving_output = False
                        self._user_text_buffer = ""
                        if self.interrupt_callback:
                            await self.interrupt_callback()

                    if sc.waiting_for_input:
                        logger.info("[gemini] waiting for input")
                        self._receiving_output = False

                    if sc.turn_complete:
                        logger.info("[gemini] turn complete")
                        self._receiving_output = False
                        self._user_text_buffer = ""
                        if self.turn_complete_callback:
                            await self.turn_complete_callback()

                if data := response.data:
                    logger.debug("[gemini] yielding %d bytes of audio", len(data))
                    yield data
