# manglara-escala-calidad

Objective: maximize Gemini Live quota usage, measure and reduce hallucinations, improve architecture/code quality. Branches: `feat/event-hardening` (S1-S6, pre-event), `refactor/architecture-quality` (S7, post-event). Delivery: ask-on-risk. Runners: server `python -m <module>` from `server/` (no pytest); web `bun test src/`.

## Specs

- S1 Video frames at low media resolution: Live config `media_resolution=MEDIA_RESOLUTION_LOW`, configurable by env (`GEMINI_MEDIA_RESOLUTION`).
- S2 Fewer video frames: client sends 1 frame every 3 s instead of 1.5 s. Camera stays on by default (user did not change it).
- S3 Preloaded knowledge budget configurable by env (`VOICE_PRELOAD_CHARS`), lowered from 60_000 to ~12_000; RAG per turn unchanged. Quality must be checked with S6 eval.
- S4 Idle sessions closed: no user speech for `VOICE_IDLE_TIMEOUT_S` (default 90) and max session length `VOICE_MAX_SESSION_MIN`; client shows a message and does not auto-reconnect.
- S5 Admission: `VOICE_MAX_NEW_SESSIONS_PER_MIN`; a Gemini quota error (1011 / "exceeded your current quota") is shown as the busy message, never the raw error.
- S6 Hallucination eval: dataset of questions (answerable from cartillas, unanswerable/out-of-scope, false premise, credits/entities), runner using the same prompt + preload + RAG as production, LLM judge, hallucination rate report. Measure baseline, reduce (prompt grounding rules / config), measure again.
- S7 Architecture and code quality (post-event): shared HTTP/genai clients, voice session module out of `main.py`, CI (server tests, `bun test`, `vite build`), lazy routes in web. No behavior change.
- Assumption: all S1-S5 knobs configurable by env so they can be tuned in Dokploy.

## Tasks

| ID | S# | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S1-S5 | inline | done (web RED observed; server tests 42 OK) | fda6bee |
| T2 | S6 harness | delegated (parallel unit, disjoint `server/eval/**`) | done (RED ImportError -> GREEN 75 checks) | see git log |
| T3 | S6 measure + reduce | inline | in progress (baseline running) | |
| T4 | S7 | delegated, worktree branch refactor/architecture-quality from fda6bee | done (differential identical routes/requests; entry chunk 1286->289 kB) | 6a2c3a7 615b499 2a53b39 4042378 |

## Log

- L1 (2026-11-07) user: "si aplica todas las optimizaciones tambien mejoremos la arquitectura y calidad de codigo de la app ademas de medir y reducir las alucinaciones"
- L2 Context: event in a few days; Gemini key quota exhausted after ~8 sessions/min in preview test; estimated per-session cost ~18k tokens at connect + ~13k tokens/min (video ~10k/min dominant).
- L3 Decision: S7 goes on a separate branch, not deployed before the event ("sin comprometer el funcionamiento").
- L4 T1 done: fda6bee. VOICE_PRELOAD_CHARS default kept at 60000 (lower only after S6 eval); media LOW default; idle 90 s default; max duration off.
- L5 T2 done: server/eval (47 cases, runner with EVAL_GEMINI_API_KEY guard, judge, report). Open: confirm official hours (20 h vs 24 h on old branch feat/manglara-grounding); spot-check unanswerable cases vs other Supabase docs before baseline.
- L6 T4 done on refactor/architecture-quality (4 commits). Follow-ups: knowledge/router.py:179, knowledge/jobs.py:77 still create per-call httpx clients; knowledge/router.py:295 per-call genai client.
- L7 (2026-11-07) user: "usa la key local y son 20 horas". Official hours = 20 h (dataset a01/a07 already match). Local .env key differs from the Dokploy production key; keyguard gains PRODUCTION_GEMINI_KEY_SHA256 mode. Probe a01: ok.
- L8 Baseline (47/47, results in ~/.cache/manglara-eval): Gemini judge gemini-3.1-flash-lite -> hallucination 13.0%, false_premise 37.5%, credits fully complete 40%; it labels unanswerable refusals as "supported" (unreliable). Prompt fixes applied in server/prompt.py (credits line, 3-source lookup, no filler assumptions, correct false premises, complete lists, PT/EN typos). Candidate run started.
- L9 (2026-11-07) user: "un suba agente vamos a juzgar para ver si el analisis esta sesgado vamos a hacer ambos a la ves y opus despues analiza ambos y saca las conclusiones finales". Plan: Sonnet subagent + gemini-flash-lite judge both baseline and candidate; Opus subagent compares all four.
- L10 Results (judges: Sonnet subagent + gemini-3.1-flash-lite; Opus adjudication): hallucination baseline 6/47 -> candidate 4/47 (McNemar p=0.5, not significant; no regressions); credits completeness 60% -> 97.1% with both judges. Gemini judge invalid for refusals (labels correct refusals "supported"). Root causes left: RAG returns the same "Página 4" chunk for 34/47 questions; launch-event docs (Agenda, Minuto a Minuto) not in loaded knowledge; greeting-only first-turn answers; a19 attribution; e02 invents cost. Candidate prompt committed.
- L11 (2026-11-07) user context: upcoming event = "4.ª Mesa Intersectorial de Empleos Verdes 2026 ... 11 de noviembre | 8:30 a. m. 📍 Táctica – Calle 75 #7-10 ... No necesitas ser parte de la Mesa, solo registrarte." The Aug 25 2026 launch (Barranquilla) is a past event; I had conflated it with the upcoming event. Round-2 prompt: greet+answer same turn, concrete roles (Diana Londoño/Gente Estratégica; Epke Vogel CINOP + Fundación PLAN reviewers, verified in Introduccion cartilla), no confirming unverified place/date/person/cost, 20 h total, Mesa section. Dataset: a10/a11/f03/e04 relabeled to what the knowledge supports; m01-m05 added (52 cases).
- L12 (2026-11-07) user: "en descarga esta la presentacion que vamos a usar en bogota". Downloads/Presentacion_Curriculo_Bogota.pdf (16 slides, image-only). Mesa is in Bogotá; presenters Andrés Prieto Navarro (Plan International) and Pedro José Sierra (FCI). The "24 h" figure is the Barranquilla hotel pilot (3 hotels, 23 participants), not the curriculum (20 h). Added presentation section to prompt (no personal emails); dataset +p01-p05 (57 cases). Round 2 stopped (stale prompt); round 3 runs on final prompt.
