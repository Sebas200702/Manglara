import asyncio
import logging
from typing import AsyncIterator, Callable, Any

from google import genai
from google.genai import types

from config import GEMINI_API_KEY, GEMINI_LIVE_MODEL, GEMINI_VOICE_NAME
from prompt import SYSTEM_PROMPT

logger = logging.getLogger(__name__)

# Without context window compression the Live API terminates a session on its
# own once the default duration is reached (a couple of minutes when video is
# being streamed, which is our case). Compression turns that hard stop into a
# sliding window instead, so a session can run indefinitely - the single biggest
# cause of a call "disconnecting" for no visible reason.
#
# The thresholds are DERIVED from the actual system instruction rather than
# fixed, and that matters more than it looks. Ours carries the whole knowledge
# preload (~55 k chars, ~15 k tokens) and grows whenever a cartilla is added. A
# fixed `target_tokens` below that size is catastrophic: the window keeps only a
# suffix, so every compression discarded the entire conversation and Manglara
# greeted the user again on each question, having forgotten everything.
#
# So: always keep the instruction plus a real conversation tail, and only
# compress once a healthy amount has accumulated on top. RAG injects retrieved
# cartilla text as a turn on nearly every turn, so the transcript grows by a
# couple of thousand tokens per exchange - the tail has to be generous.
#
# Spanish runs around 3.5 chars/token on Gemini's tokenizer. The estimate only
# has to be in the right ballpark, since both thresholds add wide margins on top.
CHARS_PER_TOKEN = 3.5
# Conversation the sliding window must never cut away.
CONVERSATION_KEEP_TOKENS = 12000
# How much may pile up beyond that before compression runs. Kept moderate so
# the total stays far inside the model's context window.
COMPRESSION_HEADROOM_TOKENS = 8000


def _compression_thresholds(system_prompt: str) -> tuple[int, int]:
    """(trigger_tokens, target_tokens) sized to fit this system instruction."""
    system_tokens = int(len(system_prompt) / CHARS_PER_TOKEN)
    target = system_tokens + CONVERSATION_KEEP_TOKENS
    return target + COMPRESSION_HEADROOM_TOKENS, target

# Bounds on transparently re-opening the upstream Gemini session. Generous
# enough to ride out a proxy blip or a server-side rotation; finite so a bad API
# key surfaces as an error instead of spinning forever.
MAX_RESUME_ATTEMPTS = 10
RESUME_BASE_DELAY_S = 0.5
RESUME_MAX_DELAY_S = 8.0


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
        # Fired around a transparent upstream reconnection so the caller can
        # tell the browser what is happening instead of going silent.
        self.on_upstream_reconnecting: Callable[[int], Any] | None = None
        self.on_upstream_reconnected: Callable[[], Any] | None = None
        # Fired whenever Gemini hands out a new resumption checkpoint, so the
        # caller can keep it beyond the life of this object - that is what lets
        # a *browser* reconnect rejoin the same conversation.
        self.on_resumption_handle: Callable[[str], Any] | None = None
        self._user_text_buffer = ""
        self._receiving_output = False
        self._system_prompt: str | None = None
        # Handle from the last `session_resumption_update`. Replays the
        # conversation state into a new socket, so a reconnect keeps the
        # context instead of restarting the conversation from scratch.
        self._resumption_handle: str | None = None
        # Set by `close()`: distinguishes "we hung up" from "the link broke",
        # which is the difference between stopping and reconnecting.
        self._closed = False

    def _build_config(self) -> dict:
        prompt = self._system_prompt or SYSTEM_PROMPT
        trigger_tokens, target_tokens = _compression_thresholds(prompt)
        config: dict = {
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
            "system_instruction": {"parts": [{"text": prompt}]},
            "context_window_compression": types.ContextWindowCompressionConfig(
                trigger_tokens=trigger_tokens,
                sliding_window=types.SlidingWindow(target_tokens=target_tokens),
            ),
            # Asking for resumption is what makes the server emit the handles
            # above; on a fresh connect `handle` is None, which just means
            # "start a new session".
            "session_resumption": types.SessionResumptionConfig(
                handle=self._resumption_handle
            ),
        }
        return config

    async def _open(self):
        self._ctx = self.client.aio.live.connect(
            model=GEMINI_LIVE_MODEL, config=self._build_config()
        )
        self.session = await self._ctx.__aenter__()

    async def connect(
        self, system_prompt: str | None = None, resumption_handle: str | None = None
    ):
        """
        Open a live session.

        `resumption_handle` rejoins an earlier conversation instead of starting a
        new one. Passing it is what keeps Manglara's memory across a browser
        reconnect: each WebSocket gets a fresh client object, so without the
        handle every dropped socket silently began a brand-new conversation and
        she introduced herself again.
        """
        self._closed = False
        self._system_prompt = system_prompt or SYSTEM_PROMPT
        self._resumption_handle = resumption_handle
        try:
            await self._open()
        except Exception:
            if not resumption_handle:
                raise
            # A handle expires, and it is rejected outright when the previous
            # session was mid-generation. Losing the history is much better than
            # failing the call.
            logger.warning("[gemini] resumption handle rejected, starting fresh")
            await self._discard_session()
            self._resumption_handle = None
            await self._open()
        logger.info(
            "[gemini] session opened (%s)",
            "resumed" if resumption_handle else "new conversation",
        )

    async def _discard_session(self):
        """Tear down the current socket, ignoring errors - it is already broken."""
        ctx, self._ctx, self.session = self._ctx, None, None
        if ctx is None:
            return
        try:
            await ctx.__aexit__(None, None, None)
        except Exception:
            pass

    async def _resume(self) -> bool:
        """
        Re-open the upstream session after it dropped, keeping the browser's
        WebSocket untouched. Tries the resumption handle first; if the server
        rejects it (handles expire, and mid-generation state is not resumable)
        falls back to a fresh session with the same system prompt.

        Returns False only once retries are exhausted.
        """
        await self._discard_session()
        # Mid-turn state belonged to the dead socket.
        self._user_text_buffer = ""
        self._receiving_output = False

        for attempt in range(1, MAX_RESUME_ATTEMPTS + 1):
            if self._closed:
                return False
            if self.on_upstream_reconnecting:
                await self.on_upstream_reconnecting(attempt)
            try:
                await self._open()
                logger.info(
                    "[gemini] session re-opened (attempt %d, %s)",
                    attempt,
                    "resumed" if self._resumption_handle else "fresh",
                )
                if self.on_upstream_reconnected:
                    await self.on_upstream_reconnected()
                return True
            except Exception as e:
                logger.warning("[gemini] resume attempt %d failed: %s", attempt, e)
                await self._discard_session()
                # Give the handle a second chance before writing the
                # conversation off: the first failure is usually the same
                # network blip that killed the session, not a rejected handle.
                # Dropping it immediately meant a one-second hiccup cost
                # Manglara her whole memory of the conversation.
                if attempt >= 2:
                    self._resumption_handle = None
                delay = min(
                    RESUME_BASE_DELAY_S * 2 ** (attempt - 1), RESUME_MAX_DELAY_S
                )
                await asyncio.sleep(delay)
        return False

    async def close(self):
        self._closed = True
        if self._ctx:
            await self._discard_session()
            logger.info("[gemini] session closed")

    async def send_audio_pcm16_16k(self, pcm: bytes):
        if not self.session:
            # Normal while a reconnect is in flight: dropping a 30 ms frame is
            # far better than propagating and taking the call down. Debug level
            # because this fires once per frame for the whole gap.
            logger.debug("[gemini] no session, dropping audio (%d bytes)", len(pcm))
            return
        try:
            await self.session.send_realtime_input(
                audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000")
            )
        except Exception as e:
            # The receive loop owns reconnection; a send that loses the race
            # with a dying socket must not bubble up and end the call.
            logger.debug("[gemini] audio send failed (%s), dropping frame", e)

    async def send_image_jpeg(self, image_data: bytes):
        if not self.session:
            return
        try:
            await self.session.send_realtime_input(
                video=types.Blob(data=image_data, mime_type="image/jpeg")
            )
        except Exception as e:
            logger.debug("[gemini] video send failed (%s), dropping frame", e)

    async def inject_context(self, text: str):
        if not self.session:
            return
        # Incremental content update: appends to the conversation without
        # closing the turn, so it can land while the user is still speaking.
        try:
            await self.session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text=text)]),
                turn_complete=False,
            )
        except Exception as e:
            logger.warning("[gemini] context injection failed: %s", e)

    async def receive_loop(self) -> AsyncIterator[bytes]:
        """
        Yield model audio for as long as the caller keeps iterating.

        An upstream drop - the duration cap, a `go_away`, a network blip - is
        handled here by re-opening the session and continuing the same
        iteration. The generator only ends when `close()` is called or
        reconnection is exhausted, so the browser's WebSocket is never taken
        down by an upstream hiccup.
        """
        while not self._closed:
            try:
                async for chunk in self._receive_once():
                    yield chunk
                # The iterator finished without raising: the server closed the
                # stream on its own (typically right after a `go_away`).
                logger.info("[gemini] upstream stream ended")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning("[gemini] upstream receive failed: %s", e)

            if self._closed:
                return
            if not await self._resume():
                raise RuntimeError("No se pudo restablecer la sesión con Gemini")

    async def _receive_once(self) -> AsyncIterator[bytes]:
        """One pass over a single live session; raises or ends when it dies."""
        session = self.session
        if session is None:
            raise RuntimeError("Gemini session is not open")

        async for response in session.receive():
            logger.debug("[gemini] response type: server_content=%s data=%s setup_complete=%s",
                "yes" if response.server_content else "no",
                "yes" if response.data else "no",
                "yes" if response.setup_complete else "no",
            )

            # Checkpoint we can replay into a new socket. Only present while
            # the session is in a resumable state, so keep the last good one.
            update = getattr(response, "session_resumption_update", None)
            if update and getattr(update, "resumable", False):
                if getattr(update, "new_handle", None):
                    self._resumption_handle = update.new_handle
                    if self.on_resumption_handle:
                        await self.on_resumption_handle(update.new_handle)

            # "I am about to hang up on you." Nothing to do but note it: the
            # stream ends right after and `receive_loop` reconnects with the
            # handle above.
            if getattr(response, "go_away", None) is not None:
                logger.info(
                    "[gemini] go_away received (time_left=%s), will reconnect",
                    getattr(response.go_away, "time_left", None),
                )

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
