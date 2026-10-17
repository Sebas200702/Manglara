# Recetas de join por proveedor — mapa de selectores

Las recetas (`server/meeting/recipes/`) automatizan la UI web de cada proveedor: entrar como invitado, detectar el estado (sala de espera, en reunión, salida) y pulsar los botones de micrófono, cámara y salir. **Los proveedores cambian su DOM a menudo**: este documento es el mapa para mantenerlas.

> Estado: ninguna receta está verificada todavía contra una reunión real. Cada archivo lleva `last_verified`; actualízalo (y la tabla de abajo) al validar con `docs/meeting-test-guide.md`.

## Cómo funcionan

Cada receta (`JoinRecipe`) declara:

| Pieza | Para qué |
|-------|----------|
| `selectors` | Listas de `{text}` (texto visible en `document.body.innerText`) o `{selector}` (CSS). Las usa el poll del backend (`poll_state`, cada 2 s) y el script inyectado (`audio_bridge.js`). Prioridad: `left` > `inMeeting` > `lobby` > `joining`. `alone` es aparte (auto-salida). |
| `entry_url(url)` | URL a abrir (Zoom convierte `/j/<id>` en el cliente web `/wc/<id>/join`). |
| `join(page, name)` | Pasos de entrada: continuar en el navegador, escribir el nombre, pedir unirse. |
| `leave(page)`, `set_mic(page, on)`, `set_cam(page, on)` | Clicks best-effort en la barra de la reunión. |

Los textos se buscan en español **y** en inglés: el navegador del bot usa `locale=es-ES`, pero algunas cuentas fuerzan inglés.

El audio y la cámara del bot **no** dependen de los selectores: el script inyectado reemplaza `getUserMedia`, así que el proveedor recibe el mic/cam falsos sin importar qué dispositivo crea haber elegido. Los botones de mic/cam solo cambian el estado visible en la reunión.

## Teams (`recipes/teams.py`)

Última verificación: sin verificar.

| Estado / acción | Textos (es / en) |
|-----------------|------------------|
| joining | "Continuar en este explorador" / "Continue on this browser", "Escribe tu nombre" / "Type your name" |
| lobby | "sala de espera", "te permitirá entrar pronto" / "lobby", "will let you in soon" |
| inMeeting | "Abandonar" / "Leave" |
| left | "Has abandonado la reunión", "Se ha acabado la reunión" / "You left the meeting", "meeting has ended" |
| alone | "Esperando a que otros se unan" / "Waiting for others to join" |
| join | "Continuar en este explorador" → nombre → "Unirse ahora" / "Join now" |
| mic | silenciado: "Activar micrófono" / "Unmute" · abierto: "Silenciar" / "Mute" |
| cam | "Activar cámara" / "Turn camera on" · "Desactivar cámara" / "Turn camera off" |
| salir | "Abandonar" / "Leave" |

Notas: con perfil logueado de Microsoft no aparece el campo de nombre (entra con el nombre de la cuenta). Reuniones de organizaciones que bloquean anónimos exigen perfil logueado.

## Zoom (`recipes/zoom.py`)

Última verificación: sin verificar.

| Estado / acción | Textos (es / en) |
|-----------------|------------------|
| entrada | `https://zoom.us/j/<id>?pwd=…` → `https://zoom.us/wc/<id>/join?pwd=…` |
| joining | "Join from Your Browser", "Your Name" / "Tu nombre" |
| lobby | "will let you in soon", "Waiting Room" / "te permitirá entrar pronto", "sala de espera" |
| inMeeting | "Mute microphone", "Unmute microphone" / "Silenciar micrófono" |
| left | "You have left the meeting", "This meeting has ended" / "Has salido de la reunión", "reunión ha terminado" |
| alone | — (el cliente web no muestra un aviso de "solo tú"; no hay auto-salida por soledad) |
| join | "Join from Your Browser" (si aparece) → nombre → "Join" / "Unirse" |
| mic | silenciado: "Unmute microphone" / "Activar micrófono" · abierto: "Mute microphone" / "Silenciar micrófono" |
| cam | "Start Video" / "Iniciar vídeo" · "Stop Video" / "Detener vídeo" |
| salir | "Leave" / "Salir" → confirmar "Leave Meeting" / "Abandonar la reunión" |

Notas: el anfitrión debe tener habilitado "unirse desde el navegador". Si la reunión exige inicio de sesión de Zoom, el bot no puede entrar como invitado.

## Google Meet (`recipes/meet.py`)

Última verificación: sin verificar.

| Estado / acción | Textos (es / en) |
|-----------------|------------------|
| joining | "Tu nombre" / "Your name", "Pedir unirse" / "Ask to join" |
| lobby | "Esperando a que te admitan", "Pidiendo unirse" / "Waiting to be let in", "Asking to join" |
| inMeeting | "Desactivar micrófono", "Activar micrófono" / "Turn off microphone", "Turn on microphone" |
| left | "Has salido de la reunión", "reunión ha terminado" / "You left the meeting", "meeting has ended" |
| alone | "Eres la única persona aquí", "No hay nadie más" / "You're the only one here" |
| join | nombre → "Pedir unirse" / "Ask to join" (invitado) o "Unirme ahora" / "Join now" (logueado) |
| mic | silenciado: "Activar micrófono" / "Turn on microphone" · abierto: "Desactivar micrófono" / "Turn off microphone" |
| cam | "Activar cámara" / "Turn on camera" · "Desactivar cámara" / "Turn off camera" |
| salir | "Salir de la llamada" / "Leave call" |

Notas: **sin cuenta Google** solo entra si el organizador permite invitados; reuniones de Workspace normalmente exigen perfil logueado (ver README → "Perfil logueado").

## Cómo actualizar una receta

1. Crea una reunión de prueba vacía (ver `docs/meeting-test-guide.md`).
2. Arranca el backend con el navegador visible:

   ```bash
   MEETING_HEADLESS=false uvicorn main:app --port 8000
   ```

3. Une el bot (`POST /meetings/join` o la pantalla `/reunion`) y observa en qué paso se queda. Los logs `[recipe] click: …` / `[recipe] fill: …` dicen qué candidato funcionó.
4. En la ventana del bot abre DevTools (F12) e inspecciona el botón o texto nuevo. Prefiere **textos visibles** (`{text}`) o `aria-label` estables (`{selector: '[aria-label*="…"]'}`) sobre clases CSS generadas.
5. Edita las constantes de la receta, añade el texto nuevo **sin borrar** el anterior (convivencia de versiones durante el rollout del proveedor) y actualiza `last_verified` con la fecha.
6. Repite el checklist del Hito A para ese proveedor y anota el resultado en la tabla de abajo.

En DevTools también tienes el puente inyectado: `window.__manglaraBridge.control({type: "set_mic", enabled: true})` simula los mensajes del backend.

## Registro de verificaciones

| Fecha | Proveedor | Resultado | Notas |
|-------|-----------|-----------|-------|
| — | Teams | pendiente | |
| — | Zoom | pendiente | |
| — | Meet | pendiente | |
