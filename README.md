# Manglara .

Llamada virtual con voz en tiempo real (Gemini Live) y avatar con estados visuales.

## Arquitectura

```
Browser (React)  ←WebSocket /ws/voice→  Backend  ←Gemini Live→  Google
```

La API key de Gemini **solo** existe en el servidor. El navegador envía audio PCM16 16 kHz y recibe audio PCM16 24 kHz + transcripciones.

## Requisitos

- [Bun](https://bun.sh/) 1.3+
- Python 3.12+ (solo para backend Python)
- `GEMINI_API_KEY` en `.env` (copiar desde `.env.example`)

## Desarrollo (backend Python + frontend Vite)

```bash
# Instalar dependencias Python
pip install -r server-python/requirements.txt

# Terminal 1: backend Python
python server-python/main.py

# Terminal 2: frontend Vite
bun run --filter web dev
```

O con un solo comando:

```bash
bun run dev:py
```

- Frontend: http://localhost:5173
- Backend + WebSocket: http://localhost:3000 (`/ws/voice`, `/health`)

## Desarrollo (backend TypeScript + frontend Vite)

```bash
# Terminal 1: backend TypeScript
bun run --filter server dev

# Terminal 2: frontend Vite
bun run --filter web dev
```

## Verificación manual

1. Abrir http://localhost:5173 → **Iniciar llamada** → permitir micrófono
2. Hablar en español → ver transcripciones y escuchar respuesta
3. El avatar cambia entre escuchando / pensando / hablando
4. En DevTools → Network: no debe haber requests a `generativelanguage.googleapis.com` desde el browser

## Build producción

```bash
bun run build
bun run --filter server start
```

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `GEMINI_API_KEY` | API key de Google AI |
| `GEMINI_LIVE_MODEL` | Modelo Live (default: gemini-3.1-flash-live-preview) |
| `GEMINI_VOICE_NAME` | Voz predefinida (default: Zephyr) |
| `PORT` | Puerto del backend (default: 3000) |
