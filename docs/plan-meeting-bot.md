# Plan de implementación — Live Meeting con Manglara

> Estado: plan aprobado, pendiente de implementación.
> Última actualización: 2026-10-16.

Manglara se une a reuniones externas de Microsoft Teams, Zoom y Google Meet, escucha a los participantes y habla con ellos (Gemini Live), con el avatar en video. Todo se configura desde la página web, sin importar el dispositivo del usuario.

## Arquitectura

```
Web UI (nuevo screen "/reunion")
   │ REST + WS /meetings
   ▼
Backend FastAPI ── MeetingBridge (Playwright + Chromium headless) ──► Página Teams/Zoom/Meet
   │                                                                     │ getUserMedia falso (mic = TTS de
   │  PCM meeting ⇄ GeminiLiveClient (reuso total)                       │  Gemini, cam = canvas del avatar)
   │                                                                     │ tee de tracks remotos → PCM
   ▼                                                                     ▼
Gemini Live (mismo pipeline de la llamada 1:1)
```

Puntos clave:

- **Audio sin drivers**: el audio se puentea 100% por JavaScript inyectado con `addInitScript` (override de `getUserMedia`, tee de tracks WebRTC). Cero drivers de audio virtual en cualquier máquina.
- **Unirse ≠ interactuar**: Manglara entra a la reunión "dormida" (audio y video configurados, Gemini Live apagado). El usuario la activa con el botón "Iniciar Manglara Meeting Live".
- **Detección automática**: al pegar el link se detecta el proveedor (Teams/Zoom/Meet) y se aplica la receta de join correspondiente.
- La llamada 1:1 existente (`/ws/voice`) no se toca.

## Flujo del usuario

1. Entra a la sección "Live Meeting con Manglara" (`/reunion`).
2. Pega el link o el ID de la reunión → badge auto-detecta el proveedor (Teams/Zoom/Meet). También se puede elegir proveedor a mano + solo el ID.
3. Pulsa **Conectar** → Manglara se une: audio y video configurados (mic/cámara virtuales listos, avatar visible en la reunión en estado idle), pero **Gemini Live apagado**: no escucha ni habla.
4. Estando en la reunión, el control principal es **▶ Iniciar Manglara Meeting Live** → activa Gemini Live y Manglara escucha y habla.
5. Controles desde la web (una vez conectada):
   - **Silenciar**: apaga solo su voz hacia la reunión (track falso mudo + botón de mic de la reunión). Gemini sigue escuchando si la interacción está activa.
   - **Cámara on/off**: video del avatar en la reunión.
   - **Apagar interacción**: cierra la sesión Gemini Live y silencia; sigue en la reunión con el avatar idle. Se puede reactivar con el botón ▶.
   - **Desconectar**: sale de la reunión y libera todo (browser, WS, Gemini).
6. Panel de transcripción (reutilizado): lo que dicen los participantes y lo que dice Manglara.

## Máquina de estados

```
Bridge:   idle → launching → joining → lobby → in_meeting → leaving → closed → (error)
Brain:    off → starting → active ⇄ off        (solo puede activarse si bridge = in_meeting)
Media:    mic[on/off]  cam[on/off]             (independientes)
```

`MeetingBridge` en `server/meeting/` orquesta todo:

- **Bridge solo**: Playwright + Chromium headless, scripts inyectados (`getUserMedia` falso, tee de tracks remotos, WS de control). El track de cámara falso = canvas del avatar **idle** (visible en la reunión desde que se une). El track de mic falso existe pero mudo.
- **Brain**: al pulsar ▶, el backend crea `GeminiLiveClient` (reuso total de `server/gemini_client.py`) y conecta los tubos: PCM del meeting → Gemini; audio de Gemini → track falso de la reunión. Transcripciones → WS a la UI. Mismo patrón half-duplex anti-eco que la llamada 1:1.
- **Controles**: `POST /meetings/join {url}`, `POST /meetings/{id}/brain/start|stop`, `POST /meetings/{id}/mic|cam {enabled}`, `POST /meetings/{id}/leave`, `WS /ws/meetings/{id}` (estado, transcripciones, eventos).

## Validación

Sin harness fake: toda validación se hace contra **reuniones reales vacías** creadas por el equipo (Teams: "Reunir ahora" → copiar link; Zoom: new meeting → link; Meet: "Nueva reunión"). Ver `docs/meeting-test-guide.md` para el checklist.

Riesgo conocido: las reuniones vacías no prueban audio de múltiples participantes — se cubre en T2.1 (una persona real entra como 2º participante desde otro dispositivo).

---

## Fase 0 — Preparación e infraestructura

### T0.1 — Dependencias

- `server/requirements.txt`: agregar `playwright>=1.49.0`.
- README: sección "Reuniones externas" con el paso único local: `python -m playwright install chromium`.
- Aceptación: `import playwright` corre en el venv local.

### T0.2 — Config

- `server/config.py`: nuevas env con defaults:
  - `MEETING_BOT_NAME=Manglara`
  - `MEETING_HEADLESS=true`
  - `MEETING_CHROME_PROFILE_DIR=""` (opcional, perfil logueado)
  - `MEETING_MAX_DURATION_MIN=180`
  - `MEETING_AVATAR_URL` (default `/meeting/avatar`)
- `.env.example` y `render.yaml` actualizados.
- Aceptación: arranque normal sin las vars definidas.

### T0.3 — Deploy

- `render.yaml`: `buildCommand: pip install -r requirements.txt && playwright install --with-deps chromium`.
- Nota en README: Render free no alcanza (~400MB) → plan starter o self-host. Dev local no requiere `--with-deps`.
- Aceptación: build limpio documentado (verificar en deploy real en Fase 5).

### T0.4 — Kit de validación real

- `docs/meeting-test-guide.md`: cómo crear reuniones de prueba vacías en Teams/Zoom/Meet + checklist por prueba (join, estados, audio in/out, controles, salida).
- Aceptación: un dev nuevo puede ejecutar cada prueba siguiendo solo el doc.

---

## Fase 1 — Backend núcleo del bridge (sin Gemini)

### T1.1 — Detección de proveedor

- `server/meeting/detector.py`:
  - `detect(url) → Provider`: regex — `teams.microsoft.com|teams.live.com` → teams; `zoom.us/j/|zoom.com/j/` → zoom; `meet.google.com/<code>` → meet.
  - `normalize(provider, input) → url` (acepta link completo o solo ID: `123456789` → `https://zoom.us/j/123456789`, etc.).
- Tests unit (12 casos: 3 proveedores × link/ID/válido-inválido).
- Aceptación: tests verdes.

### T1.2 — Modelos de sesión

- `server/meeting/models.py`:
  - `BridgeState = idle|launching|joining|lobby|in_meeting|leaving|closed|error`
  - `BrainState = off|starting|active|stopping`
  - `MediaState { mic_enabled, cam_enabled }`
  - `MeetingSession` (id, provider, url, name, estados, timestamps, event bus).
- Aceptación: dataclasses importables, sin lógica.

### T1.3 — Script inyectado (el corazón)

- `server/meeting/audio_bridge.js` (instalado con `context.add_init_script` ANTES de navegar):
  1. Override `navigator.mediaDevices.getUserMedia` → `MediaStream` sintético:
     - audio: `MediaStreamAudioDestinationNode` (mic falso, arranca mudo)
     - video: canvas `captureStream(30)` — Fase 1: logo Manglara + animación sutil (rAF); Fase 4: avatar
     - también `enumerateDevices` (reporta mic/cam falsos como default) y `getSettings` coherentes.
  2. Tee de audio remoto: patch `RTCPeerConnection` evento `track` → `MediaStreamSource` → `AudioWorklet` downsample a 16 kHz mono Int16 → enviar por WS de control como `{type:"remote_pcm", data:b64}`.
  3. Cliente WS interno (`/ws/meetings/{id}/bridge`): recibe `{type:"bot_pcm"}` (24 kHz) → `AudioBuffer` → reproducir al `MediaStreamAudioDestinationNode`; `{type:"set_mic"}`, `{type:"set_cam"}`.
  4. Reporta: `ready`, `gum_called` (la página pidió mic/cam = señal de progreso de join), `meeting_state` (poll de selectores por proveedor inyectados por la receta), logs de debug.
  5. `unload` → envía `left`.
- Aceptación: en reunión real vacía, el PCM remoto llega al backend y `bot_pcm` se escucha (verificar en la UI de la reunión que "Manglara está hablando").

### T1.4 — Browser (Playwright)

- `server/meeting/browser.py`:
  - `launch_chromium()` con flags: `--headless=new`, `--autoplay-policy=no-user-gesture-required`, `--use-fake-ui-for-media-stream`, `--no-first-run`, `--mute-audio`.
  - Contexto persistente opcional (`MEETING_CHROME_PROFILE_DIR`); `grant_permissions(["microphone","camera"])`; viewport 1280×720.
  - Un browser por reunión; teardown garantizado (try/finally + señal de shutdown).
- Aceptación: navega a una reunión real sin errores de permisos ni autoplay.

### T1.5 — MeetingBridge (orquestador)

- `server/meeting/bridge.py`:
  - `MeetingBridge(session)` — máquina de estados completa, un solo dueño (asyncio task principal).
  - WS `/ws/meetings/{id}/bridge` (interno, auth por id random de 128 bits): solo la página inyectada puede conectar.
  - Eventos → WS público de la UI (T1.7). Watchdog: si el WS interno muere 30 s o `left`, marcar closed y limpiar.
  - Callbacks: `on_remote_pcm`, `on_bot_pcm_sink` (interfaz desacoplada para Fase 2).
- Aceptación: ciclo completo launching → lobby → in_meeting → leaving → closed en reunión real.

### T1.6 — Recetas por proveedor

- `server/meeting/recipes/base.py`: interfaz `JoinRecipe` (`join_steps(page, name)`, `poll_state(page) → lobby|in_meeting|left|waiting_admission`, `set_mic(page, on)`, `set_cam(page, on)`) + `SELECTORS` documentado.
- `recipes/teams.py`: "Continuar en este navegador" → nombre → "Unirse ahora" → lobby ("Esperando en la sala de espera") → toolbar = in_meeting. Mic/cam por botones `[aria-label*="Silenciar"/"Cámara"]`.
- `recipes/zoom.py`: "Unirse desde el navegador" (o directo `/wc/join/`) → "Tu nombre" → "Unirse" → espera ("El anfitrión le permitirá entrar") → toolbar con botón Silenciar = in_meeting.
- `recipes/meet.py`: "Tu nombre" → "Pedir para unirse" (invitado) o "Unirme ahora" → admisión → barra inferior con mic = in_meeting. Nota: sin cuenta Google solo si el organizador permite invitados.
- Selectores en constantes por archivo, con fecha de última verificación para mantenimiento.
- Aceptación: 1 reunión real por proveedor, resultado anotado en `docs/meeting-provider-recipes.md`.

### T1.7 — API REST + WS público

- `server/meeting/router.py`:
  - `POST /meetings/join {url|id, name?}` → detecta, crea sesión, lanza bridge → `{id}`. 409 si ya hay una activa (1 reunión a la vez, v1).
  - `POST /meetings/{id}/leave`
  - `POST /meetings/{id}/mic {enabled}` / `POST /meetings/{id}/cam {enabled}`
  - `GET /meetings/{id}` (estado actual, para recargar la UI)
  - `WS /ws/meetings/{id}`: `{type:"state", bridge, brain, media}`, `{type:"transcript", role:"participant"|"manglara", text}`, `{type:"error"}`.
- Registrar router en `main.py`. NO tocar `/ws/voice`.
- Aceptación: curl del flujo completo contra una reunión real.

---

## Fase 2 — Cerebro (Gemini Live on/off)

### T2.1 — Integración Gemini

- En `bridge.py`: `brain_start()` / `brain_stop()`:
  - start: instancia `GeminiLiveClient` (reuso total, con system prompt de reunión), conecta; `on_remote_pcm → send_audio_pcm16_16k`; `receive_loop → bot_pcm` al WS interno.
  - Transcripciones Gemini → WS público (`manglara`); transcripción de participantes desde `input_transcription` (si el modelo no da speaker tags, etiquetar "Participante").
  - Half-duplex: mientras Manglara habla → `set_mic(enabled=false)` al track falso + botón mic de la reunión (receta); al terminar turno → reabrir (mismo patrón `MIC_REOPEN_GUARD_MS`).
  - stop: `gemini.close()`, set_mic off, estado dormida. Re-start permitido n veces en la misma sesión.
- Aceptación: reunión real con 1 persona más (2º dispositivo) — Manglara responde audible; stop/start repetido sin fugas.

### T2.2 — Prompt de reunión

- `server/meeting/prompt.py` (o extensión de `prompt.py`): instrucciones de reunión — esperar turnos, no hablar encima, mantenerse en tema, respuesta corta y natural. Reusa el contexto RAG existente si aplica.
- Aceptación: review manual del prompt, conversación coherente en prueba real.

---

## Fase 3 — Frontend "Live Meeting con Manglara"

### T3.1 — Cliente API

- `web/src/lib/meeting-client.ts`: REST join/leave/mic/cam + WS de eventos con reconexión; tipados `MeetingState`, `MeetingEvent` (patrón `voice-client.ts`).
- Aceptación: unit test del parseo de eventos.

### T3.2 — Store

- `web/src/screens/meeting-screen/meeting-screen-store.ts` (zustand): `bridgeState`, `brainState`, `micOn`, `camOn`, `provider` (detectado), `error`, `transcripts`, `connecting`; actions setters + reset (patrón `call-screen-store`).

### T3.3 — Hook

- `web/src/screens/meeting-screen/use-meeting-screen.ts`:
  - `detectProvider(input)`: regex local inmediato (feedback al pegar) + confirmación del backend al unirse.
  - `connect(input)`, `startBrain()`, `stopBrain()`, `toggleMic()`, `toggleCam()`, `leave()`.
  - Errores legibles: "URL no reconocida", "Manglara ya está en una reunión", "Admisión pendiente", etc.

### T3.4 — Pantalla

- `web/src/screens/meeting-screen/meeting-screen.tsx` (+ `index.ts`):
  - Header igual al call-screen (Logo + título "Live Meeting con Manglara").
  - Card de conexión: input link/ID + badge de proveedor auto (Teams/Zoom/Meet con color propio) + botón **Conectar** (disabled mientras connecting).
  - Estados visibles: Sin conexión / Conectando… / En reunión (dormida) / En reunión (escuchando/hablando) / En sala de espera / Error. Chip de estado con color (patrón header actual).
  - Panel de control (visible solo `in_meeting`):
    - Botón principal grande: `▶ Iniciar Manglara Meeting Live` (dormida) / `⏸ Apagar interacción` (activa).
    - Controles secundarios: Silenciar (Mic/MicOff), Cámara (Video/VideoOff), Desconectar (PhoneOff, rojo) — mismos íconos lucide que call-screen.
  - Panel de transcripción reutilizado (`TranscriptPanel`) con roles "Participante" / "Manglara".
  - Fondo manglar (`MangroveVideo` idle) para coherencia visual.
- Aceptación: flujo manual completo en reunión real.

### T3.5 — Navegación

- `web/src/router.tsx`: ruta hija `/reunion` → `MeetingScreen`.
- Navegación simple entre secciones ("Llamada 1:1" ↔ "Reunión") con `Link` de react-router.
- Aceptación: cambiar de sección no rompe una llamada 1:1 activa ni una reunión activa (stores separados).

---

## Fase 4 — Avatar en video dentro de la reunión

### T4.1 — Renderer standalone del avatar

- `web/avatar-page/` (nuevo entry de Vite) o página estática servida por backend `/meeting/avatar`: canvas + TalkingHead con el GLB actual (reuso de `avatar-controller`/lipsync), modo idle (respira, parpadea, sonrisa suave) y modo speaking.
- Aceptación: abre solo en browser, avatar animado a 30 fps.

### T4.2 — Cámara falsa = avatar

- En `audio_bridge.js`: inyectar `<iframe src="{MEETING_AVATAR_URL}">` (origen backend, permite framing) → la página del avatar hace `captureStream(30)` → `postMessage(stream, parentOrigin)` (MediaStream es clonable por structured clone) → script lo asigna como track de cámara del `MediaStream` sintético.
- Fallback automático a imagen estática si el iframe tarda > 5 s.
- Aceptación: en reunión real, los participantes ven el avatar animado.

### T4.3 — Lipsync del avatar en la reunión

- Backend reenvía el transcript de Manglara al WS interno → `audio_bridge.js` → `postMessage({type:"lip_text"})` al iframe → `feedTranscript` (mismo pipeline que la llamada 1:1).
- Estados idle/speaking también por postMessage.
- Aceptación: boca sincronizada con su voz durante la reunión.

---

## Fase 5 — Robustez, seguridad y docs

### T5.1 — Perfiles logueados

- Soporte real de `MEETING_CHROME_PROFILE_DIR` (persistent context): docs one-time setup ("loginéate en Meet/Teams en este perfil con `MEETING_HEADLESS=false` una vez"). Meet sin cuenta queda como limitación documentada.
- Aceptación: join a un Meet de workspace con perfil logueado.

### T5.2 — Resiliencia

- Auto-leave cuando la reunión termina o quedan 0 participantes (receta `poll_state` → `left` → limpiar y avisar a la UI).
- Watchdog: WS interno muerto → 1 reintento → closed con error claro.
- Máx. duración (`MEETING_MAX_DURATION_MIN`) → leave ordenado + aviso.
- Aceptación: matar el browser a mano → la UI muestra error coherente y el backend queda limpio.

### T5.3 — Cola y límites

- Cola simple de 1 reunión activa (ya en T1.7) + mensaje en UI "Ya hay una reunión activa". Endpoint `GET /meetings` para debug.
- Aceptación: segundo join devuelve 409 con mensaje en español.

### T5.4 — Docs

- `docs/meeting-provider-recipes.md`: mapa de selectores por proveedor + fecha de última verificación + cómo actualizarlos (inspección con `MEETING_HEADLESS=false`).
- README: sección de la feature (requisitos, envs, disclaimer de ToS: los bots automáticos pueden violar términos de los proveedores; usar cuenta propia y nombre identificable).
- Aceptación: un dev nuevo levanta una reunión real siguiendo solo el README.

### T5.5 — Seguridad

- No loggear audio (solo metadatos/tamaños). No loggear URLs completas de reunión (solo dominio + id corto).
- Validar provider soportado antes de lanzar browser; límite de tamaño en inputs de la API.
- Aceptación: revisión de `logger` en bridge/router sin datos sensibles.

---

## Hitos de verificación

1. **Hito A** (Fase 0 + T1.1–T1.7): Manglara se une y sale de reuniones reales (las 3), muda/desmuda mic y cam desde la API, sin hablar.
2. **Hito B** (Fase 2 + Fase 3): desde la web `/reunion` se une, se activa Gemini con el botón ▶, habla y escucha; silenciar/cámara/apagar/desconectar funcionan. Prueba manual Zoom + Teams reales.
3. **Hito C** (Fase 4): avatar en video con lipsync en la reunión.
4. **Hito D** (Fase 5): perfiles, resiliencia, docs finales, deploy Render validado.

## Riesgos conocidos

- **Selectores frágiles**: los 3 proveedores cambian su DOM seguido → recetas aisladas + docs de mantenimiento.
- **Meet sin cuenta**: join invitado requiere que el organizador lo habilite; si no, perfil logueado obligatorio (T5.1).
- **ToS**: bots automáticos en reuniones pueden violar términos de Teams/Zoom/Meet — usar cuenta propia y nombre identificable ("Manglara"). Responsabilidad del usuario.
- **Latencias**: reunión web → tee JS → WS → Gemini → WS → track falso; medir round-trip en el Hito A y ajustar buffers.
- **Render free**: Chromium (~400MB) no cabe → plan starter o self-host.
