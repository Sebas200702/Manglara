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
- Backend + WebSocket: http://localhost:8000 (`/ws/voice`, `/health`)

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

## Reuniones externas (Live Meeting con Manglara)

Manglara puede unirse a reuniones externas de Microsoft Teams, Zoom y Google Meet como participante: escucha, habla (Gemini Live) y aparece en video con su avatar 3D. El bot corre Chromium headless desde el backend y puentea el audio por JavaScript inyectado, así que no necesita drivers de audio virtual en ninguna máquina. Todo se controla desde la sección **Reunión** de la web (`/reunion`).

### Requisitos

- Backend Python con las dependencias de `server/requirements.txt` (incluye Playwright).
- Chromium para Playwright, una vez por máquina:

  ```bash
  python -m playwright install chromium
  ```

- La web app corriendo (`bun run dev`): el bot carga de ahí la página del avatar (`/meeting/avatar`) que usa como cámara. Si no está disponible, la cámara muestra un logo animado.

> En Render el build ya instala Chromium (`render.yaml`), pero el plan free
> no tiene RAM/disco suficiente (~400 MB): usar plan starter o self-host.

### Levantar una reunión real (dev local)

1. Backend en `server/`: `uvicorn main:app --port 8000` (con `.env` completo).
2. Web: `bun run dev` → abre http://localhost:5173/reunion.
3. Crea una reunión de prueba vacía en Teams, Zoom o Meet y copia el link (ver `docs/meeting-test-guide.md`).
4. Pega el link (o el ID de Zoom/Meet) → el badge detecta el proveedor → **Conectar**.
5. Desde la reunión, como anfitrión, **admite a "Manglara"** desde la sala de espera. La web pasa a "En reunión (dormida)": se ve el avatar pero no escucha ni habla.
6. Pulsa **▶ Iniciar Manglara Meeting Live**: se presenta y responde a los participantes.
7. Controles: **Silenciar** (corta su voz; sigue escuchando), **Cámara**, **Apagar interacción** (vuelve a dormida, reactivable) y **Desconectar** (sale y libera todo).

Para ver qué hace el bot, arranca el backend con `MEETING_HEADLESS=false`: se abre la ventana de Chromium.

Solo hay **una reunión activa a la vez**; un segundo intento devuelve 409 ("Manglara ya está en una reunión"). Manglara sale sola si la reunión termina, si se queda sola `MEETING_ALONE_TIMEOUT_MIN` minutos o al llegar a `MEETING_MAX_DURATION_MIN`.

### Perfil logueado (Meet de Workspace, Teams de organización)

Muchas reuniones no admiten invitados anónimos. Para esas, el bot puede usar un perfil de Chromium con sesión iniciada:

1. Define `MEETING_CHROME_PROFILE_DIR` en `.env` (p. ej. `./.meeting-profile`).
2. Con el backend detenido, en `server/`: `python -m meeting.login_profile` → se abre Chromium visible; inicia sesión en Google y/o Microsoft con la cuenta del bot y cierra la ventana.
3. Las siguientes reuniones entran con esa cuenta (el nombre visible será el de la cuenta).

Meet **sin cuenta** solo funciona si el organizador permite invitados: es una limitación conocida.

### Aviso de términos de servicio

Los bots automáticos en reuniones pueden violar los términos de uso de Microsoft Teams, Zoom o Google Meet. Usa una cuenta propia, un nombre identificable ("Manglara") y avisa a los participantes de que hay un asistente de IA escuchando. La responsabilidad del uso es de quien despliega el bot.

### Mantenimiento

- Los proveedores cambian su interfaz: el mapa de selectores y cómo actualizarlos está en `docs/meeting-provider-recipes.md`.
- Checklist de pruebas reales: `docs/meeting-test-guide.md`.
- Tests sin red (desde `server/`): `python meeting/test_detector.py`, `python -m meeting.test_brain`, `python -m meeting.test_lifecycle`, `python -m meeting.test_router`. Web: `bun test` en `web/`.
- Plan de implementación completo: `docs/plan-meeting-bot.md`.

## Build producción

```bash
bun run build
bun run --filter server start
```

## Despliegue de la web (Dokploy / Railpack)

La web es un workspace de un monorepo (`packages/shared` + `web`) y la
dependencia `@manglara/shared` **nunca se publica en npm**: solo existe en el
repo. Por eso el build **no** puede correr en el subdirectorio `web/`; si lo
hace, `npm install` busca `@manglara/shared` en el registro y falla con
`404 Not Found - GET https://registry.npmjs.org/@manglara/shared`.

Configuración en Dokploy (Application → General → Build):

|Ajuste | Valor | Por qué |
|---|---|---|
| Build Path | `/` (raíz del repo, **no** `/web`) | Railpack solo resuelve workspaces npm/bun si el `package.json` raíz está en el contexto del build. Con `/web` desaparece `packages/shared` |
| Build Type | `railpack` | — |
| Environment → `RAILPACK_SPA_OUTPUT_DIR` | `web/dist` | Fuerza el modo sitio estático (Caddy) y le dice a Railpack dónde queda el `dist`, que al compilar en la raíz queda en `web/dist` |

En la raíz hay un `railpack.json` que fija `"provider": "node"`: sin él Railpack
ve el `pyproject.toml` de la raíz (config de pyright) y despliega el backend
Python en vez de la web.

Variables de entorno que la app necesita (Vite las *inlinea en build time*, así
que van en el build, no solo en runtime):

| Variable | Para qué |
|---|---|
| `VITE_BACKEND_URL` | Origen del backend (`https://api.tu-dominio.co`). Si no está, el bundle apunta a `localhost:8000` |
| `VITE_AVATAR_URL` | Opcional. Ruta del GLB del avatar. Por defecto `/custom_avatar.glb` |
| `RAILPACK_SPA_OUTPUT_DIR` | `web/dist` (ver arriba) |

El backend Python se despliega aparte (ver `render.yaml`, `rootDir: server`).

## Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `GEMINI_API_KEY` | API key de Google AI |
| `GEMINI_LIVE_MODEL` | Modelo Live (default: gemini-3.1-flash-live-preview) |
| `GEMINI_VOICE_NAME` | Voz predefinida (default: Zephyr) |
| `PORT` | Puerto del backend (default: 8000) |
| `CORS_ALLOW_ORIGINS` | Orígenes extra del frontend con permiso CORS, coma-separados (la web desplegada) |
| `MEETING_BOT_NAME` | Nombre del bot en la reunión (default: Manglara) |
| `MEETING_HEADLESS` | `false` abre la ventana de Chromium para depurar (default: true) |
| `MEETING_CHROME_PROFILE_DIR` | Perfil persistente con sesión iniciada (vacío = invitado) |
| `MEETING_MAX_DURATION_MIN` | Duración máxima de una reunión (default: 180) |
| `MEETING_ALONE_TIMEOUT_MIN` | Sale si se queda sola este tiempo; 0 = nunca (default: 10) |
| `MEETING_WEB_URL` | URL pública de la web app, donde el bot abre el avatar (default: http://localhost:5173) |
| `MEETING_AVATAR_URL` | Ruta (o URL absoluta) de la página del avatar (default: /meeting/avatar) |

## Panel de conocimiento

Gestión de cartillas sin tocar código: `/conocimiento` (clave única del
gestor, cookie de sesión de 12 h). Ver `docs/conocimiento-runbook.md`
para el flujo completo, el reciclaje de clave y la operativa de backup.

Variables nuevas (todas opcionales excepto la clave del gestor):

| Variable | Descripción |
|----------|-------------|
| `ADMIN_PASSWORD_HASH` | Clave del panel en `scrypt:N:r:p:salt:hash` (genera con `python scripts/hash_password.py`) |
| `ADMIN_PASSWORD` | Alternativa en claro (no recomendado; se ignora si hay hash) |
| `SESSION_SECRET` | Firma de la cookie; si falta, se deriva de la clave |
| `SESSION_TTL_HOURS` | Horas de sesión (default: 12) |
| `LOGIN_ATTEMPTS_PER_MINUTE` | Rate limit del login (default: 5) |
| `GEMINI_EMBEDDING_MODEL` | Embeddings (default: gemini-embedding-2) |
| `GEMINI_EMBEDDING_DIM` | Dimensión del vector (default: 384, coincide con `vector(384)`) |
