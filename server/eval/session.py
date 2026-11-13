"""One eval case = one Live session driven like production's `/ws/voice`.

Production (`main._voice_session`) connects with
`build_system_prompt(build_knowledge_context(active_ids))`, then, while the
person speaks, injects `LANGUAGE_REMINDER` on the first turn and
`CONTEXT_NOTE + retrieved context` from `retrieve_context`. Here the question
arrives as text instead of speech, so both notes are injected right before it
and the answer is the model's output transcription.
"""

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from prompt import CONTEXT_NOTE, LANGUAGE_REMINDER

Retrieve = Callable[[list[str], str], Awaitable[str]]
MakeClient = Callable[[], Any]


@dataclass
class Knowledge:
    doc_ids: list[str]
    system_prompt: str
    preload_chars: int


async def ask(client, system_prompt: str, notes: list[str], question: str,
              timeout_s: float = 45.0, grace_s: float = 1.0) -> dict:
    """Open a session, ask once, collect the model transcript, always close."""
    parts: list[str] = []
    done = asyncio.Event()

    async def on_transcript(role: str, text: str):
        if role == "model":
            parts.append(text)

    async def on_turn_complete():
        done.set()

    client.transcript_callback = on_transcript
    client.turn_complete_callback = on_turn_complete

    result = {"answer": "", "timed_out": False, "error": None, "duration_s": 0.0}
    started = time.monotonic()
    receiver = None
    try:
        await client.connect(system_prompt=system_prompt)

        async def drain_audio():
            async for _ in client.receive_loop():
                pass

        receiver = asyncio.create_task(drain_audio())
        for note in notes:
            await client.inject_context(note)
        await client.send_text(question)

        waiter = asyncio.create_task(done.wait())
        finished, _ = await asyncio.wait(
            {waiter, receiver}, timeout=timeout_s, return_when=asyncio.FIRST_COMPLETED
        )
        waiter.cancel()
        if waiter in finished:
            if grace_s:
                # Output transcription can trail turn_complete by a moment.
                await asyncio.sleep(grace_s)
        elif receiver in finished:
            exc = receiver.exception()
            result["error"] = f"receive loop ended: {exc}" if exc else "receive loop ended"
        else:
            result["timed_out"] = True
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
    finally:
        if receiver is not None and not receiver.done():
            receiver.cancel()
            try:
                await receiver
            except BaseException:
                pass
        try:
            await client.close()
        except Exception as e:
            result["error"] = result["error"] or f"close failed: {e}"
        result["answer"] = "".join(parts).strip()
        result["duration_s"] = round(time.monotonic() - started, 2)
    return result


async def run_case(case: dict, knowledge: Knowledge, retrieve: Retrieve,
                   make_client: MakeClient, timeout_s: float = 45.0,
                   grace_s: float = 1.0) -> dict:
    notes = [LANGUAGE_REMINDER]
    context, retrieval_error = "", None
    if knowledge.doc_ids:
        try:
            context = await retrieve(knowledge.doc_ids, case["question"])
        except Exception as e:
            retrieval_error = str(e)
    if context:
        notes.append(CONTEXT_NOTE + "\n\n" + context)

    outcome = await ask(make_client(), knowledge.system_prompt, notes,
                        case["question"], timeout_s=timeout_s, grace_s=grace_s)
    return {
        **case,
        **outcome,
        "retrieved_context": context,
        "retrieval_error": retrieval_error,
        "preload_chars": knowledge.preload_chars,
    }
