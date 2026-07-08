import asyncio
import logging
from typing import AsyncIterator, Callable, Any

from google import genai
from google.genai import types

from config import GEMINI_API_KEY, GEMINI_LIVE_MODEL, GEMINI_VOICE_NAME
from prompt import SYSTEM_PROMPT

logger = logging.getLogger(__name__)


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
        self.on_user_turn_complete: Callable[[str], Any] | None = None
        self._user_text_buffer = ""
        self._receiving_output = False

    async def connect(self):
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
            realtime_input_config=types.RealtimeInputConfig(
                turn_coverage="TURN_INCLUDES_ONLY_ACTIVITY"
            ),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=GEMINI_VOICE_NAME
                    )
                )
            ),
            system_instruction=SYSTEM_PROMPT,
        )

        self._ctx = self.client.aio.live.connect(model=GEMINI_LIVE_MODEL, config=config)
        self.session = await self._ctx.__aenter__()
        logger.info("[gemini] session opened")

    async def close(self):
        if self._ctx:
            await self._ctx.__aexit__(None, None, None)
            self._ctx = None
            self.session = None
            logger.info("[gemini] session closed")

    async def send_audio_pcm16_16k(self, pcm: bytes):
        if not self.session:
            return
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
        await self.session.send_realtime_input(text=text)

    async def receive_loop(self) -> AsyncIterator[bytes]:
        while True:
            async for response in self.session.receive():
                sc = response.server_content

                if sc:
                    if getattr(sc, "input_transcription", None):
                        text = getattr(sc.input_transcription, "text", None)
                        if text:
                            self._user_text_buffer += text
                            self._receiving_output = False
                            if self.transcript_callback:
                                await self.transcript_callback("user", text)

                    if getattr(sc, "output_transcription", None):
                        text = getattr(sc.output_transcription, "text", None)
                        if not self._receiving_output and self._user_text_buffer.strip():
                            user_text = self._user_text_buffer
                            self._user_text_buffer = ""
                            if self.on_user_turn_complete:
                                asyncio.create_task(self.on_user_turn_complete(user_text))
                        self._receiving_output = True
                        if text and self.transcript_callback:
                            await self.transcript_callback("model", text)

                    if sc.turn_complete:
                        if self.turn_complete_callback:
                            await self.turn_complete_callback()
                        break

                if data := response.data:
                    yield data
