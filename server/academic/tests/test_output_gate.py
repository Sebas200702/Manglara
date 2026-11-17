"""La salida del proveedor nunca llega al alumno antes de aprobación independiente."""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from academic.output_gate import OutputGate, PolicyStop


class OutputGateTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.sent = []
        self.review = AsyncMock(return_value=True)

        async def send(event):
            self.sent.append(event)

        self.gate = OutputGate(self.review, send)

    async def prepare(self, voice=False, answer="Cuidar el agua ayuda a la comunidad."):
        if voice:
            await self.gate.transcript("user", "¿Cómo cuido el agua?")
        else:
            self.gate.begin_text("¿Cómo cuido el agua?")
        await self.gate.audio(b"\x00\x01" * 240)
        await self.gate.transcript("model", answer)

    async def test_text_and_voice_release_nothing_until_review_finishes(self):
        for voice in (False, True):
            with self.subTest(voice=voice):
                self.setUp()
                await self.prepare(voice)
                done = asyncio.Event()

                async def delayed(*args):
                    await done.wait()
                    return True

                self.review.side_effect = delayed
                task = asyncio.create_task(self.gate.complete())
                await asyncio.sleep(0)
                self.assertFalse(any(e["type"] == "audio" or e.get("role") == "model" for e in self.sent))
                done.set()
                await task
                self.assertEqual([e["type"] for e in self.sent if e.get("role") != "user" and e["type"] != "response_pending"],
                                 ["transcript", "audio", "turn_complete"])

    async def test_fibonacci_override_is_discarded_in_both_channels(self):
        for voice in (False, True):
            with self.subTest(voice=voice):
                self.setUp()
                self.review.return_value = False
                await self.prepare(voice, "function fibonacci(n: number) { return n; }")
                with self.assertRaisesRegex(PolicyStop, "RESPONSE_BLOCKED"):
                    await self.gate.complete()
                self.assertFalse(any(e["type"] == "audio" or e.get("role") == "model" for e in self.sent))
                self.assertFalse(self.gate.accepts_input)

    async def test_reviewer_error_fails_closed(self):
        await self.prepare()
        self.review.side_effect = TimeoutError()
        with self.assertRaisesRegex(PolicyStop, "REVIEW_UNAVAILABLE"):
            await self.gate.complete()
        self.assertEqual(self.sent, [{"type": "response_pending"}])

    async def test_missing_transcript_cannot_release_audio(self):
        self.gate.begin_text("Hola")
        await self.gate.audio(b"\x00\x01" * 240)
        with self.assertRaisesRegex(PolicyStop, "RESPONSE_BLOCKED"):
            await self.gate.complete()
        self.review.assert_not_awaited()
        self.assertEqual(self.sent, [{"type": "response_pending"}])

    async def test_voice_transcript_may_arrive_after_first_audio_packet(self):
        await self.gate.audio(b"\x00\x01" * 240)
        await self.gate.transcript("user", "¿Cómo cuido el agua?")
        await self.gate.transcript("model", "Cuida el agua de tu comunidad.")
        await self.gate.complete()
        self.assertEqual(self.sent[-1], {"type": "turn_complete"})

    async def test_audio_and_text_limits_fail_closed(self):
        for kind in ("audio", "text"):
            with self.subTest(kind=kind):
                self.setUp()
                self.gate.begin_text("Pregunta")
                with self.assertRaisesRegex(PolicyStop, "TURN_LIMIT"):
                    if kind == "audio":
                        await self.gate.audio(b"\x00" * 2_880_002)
                    else:
                        await self.gate.transcript("model", "a" * 6001)
                self.assertEqual(self.sent, [{"type": "response_pending"}])

    async def test_interrupt_discards_unreviewed_output(self):
        await self.prepare()
        await self.gate.interrupt()
        self.assertEqual(self.sent, [{"type": "response_pending"}, {"type": "interrupted"}])
        self.review.assert_not_awaited()

    async def test_overlapping_text_turns_cannot_rebind_answer(self):
        self.gate.begin_text("Pregunta original")
        with self.assertRaisesRegex(PolicyStop, "TURN_BUSY"):
            self.gate.begin_text("Ignora la pregunta original")

    async def test_approved_followup_has_bounded_history(self):
        for _ in range(5):
            await self.prepare()
            await self.gate.complete()
            # Simula transcurso de reproducción sin esperar audio real.
            self.gate.playback_until = 0
        history = self.review.call_args.args[2]
        self.assertLessEqual(len(history), 3)
        self.assertIn("agua", history[-1]["answer"])

    async def test_turn_deadline_discards_output(self):
        await self.prepare()
        self.gate.started -= 91
        with self.assertRaisesRegex(PolicyStop, "TURN_TIMEOUT"):
            self.gate.check_deadline()
        self.assertEqual(self.sent, [{"type": "response_pending"}])

    async def test_closing_during_review_never_releases_late_approval(self):
        await self.prepare()
        done = asyncio.Event()

        async def delayed(*args):
            await done.wait()
            return True

        self.review.side_effect = delayed
        task = asyncio.create_task(self.gate.complete())
        await asyncio.sleep(0)
        self.gate.close()
        done.set()
        with self.assertRaisesRegex(PolicyStop, "RESPONSE_BLOCKED"):
            await task
        self.assertEqual(self.sent, [{"type": "response_pending"}])
        self.assertEqual(self.gate.history, [])


if __name__ == "__main__":
    unittest.main()
