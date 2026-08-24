# Avatar conversacional (TalkingHead + HeadAudio)

Cabeza 3D que habla con lip-sync en tiempo real y animaciones naturales
(parpadeo, movimiento de cabeza, contacto visual, respiración) sobre el flujo
de voz existente (Gemini Live).

## Por qué este stack

Gemini Live entrega **PCM crudo a 24 kHz sin visemas ni timestamps**, pero sí
entrega la **transcripción del texto** que dice el asistente
(`output_audio_transcription`, ver `server/gemini_client.py`). Por eso:

- **TalkingHead** (`@met4citizen/talkinghead`, npm) renderiza el avatar,
  reproduce el PCM vía su streaming API y aporta las animaciones naturales
  integradas.
- **El lip-sync se deriva del TEXTO, no del audio** ([`lipsync-es.ts`](./lipsync-es.ts)).
  El español es casi perfectamente fonémico, así que del texto salen visemas
  Oculus reales y legibles.
- **Las formas se CONSUMEN, no se programan** ([`viseme-driver.ts`](./viseme-driver.ts)).
  Ver "Sincronía" abajo — esto es lo que más cuesta acertar.
- **HeadAudio** (met4citizen, **no está en npm** → vendorizado en
  `public/headaudio/`) detecta visemas desde el audio (MFCC) y queda como
  **fallback**: su modelo está entrenado en inglés y sobre habla en español se
  comporta casi como un detector de energía (la boca solo abre y cierra, no se
  pueden leer los labios). Cede el control cuando el texto tiene algo que decir.

> ⚠️ HeadAudio y nuestro driver escriben **el mismo slot** de morph (`newvalue`),
> así que si ambos escriben se pelean frame a frame. Solo uno puede ganar por
> frame: el gate es `textInCharge` dentro de `ha.onvalue`. No es una
> optimización, es corrección.

## Piezas

| Archivo | Rol |
|---|---|
| [`avatar-controller.ts`](./avatar-controller.ts) | Envuelve TalkingHead + HeadAudio: `init()` carga el avatar; `startStream()` entra en streaming; `feedAudio()` recibe PCM; `feedTranscript()` recibe el texto y programa los visemas; `setState()` mapea idle/listening/thinking/speaking a gaze. |
| [`lipsync-es.ts`](./lipsync-es.ts) | Texto español → formas de boca con duraciones estimadas (u muda de `qu`/`gu`, `ü`, seseo, dígrafos `ch`/`ll`/`rr`, diptongos, `h` muda). |
| [`viseme-driver.ts`](./viseme-driver.ts) | Consume esas formas al ritmo del audio que queda en el buffer. Puro y sin dependencias para poder simularlo y testearlo. |
| [`lip-shapes.ts`](./lip-shapes.ts) | Configuración labial por visema (apertura, anchura, redondez, protrusión, dientes, lengua, pliegue /f/) + mezcla de los dos visemas dominantes. |
| [`avatar.tsx`](./avatar.tsx) | Componente React: monta el canvas de TalkingHead, muestra `avatar.png` como fallback hasta cargar. |
| [`talkinghead.d.ts`](./talkinghead.d.ts) | Tipos mínimos para la librería (no trae tipos). |
| `public/avatar1.glb` | Avatar Ready Player Me (Wolf3D). Tiene `Armature`, 72 morph targets: visemas Oculus + ARKit blendshapes + huesos de ojos. |
| `public/headaudio/*` | `headaudio.min.mjs`, `headworklet.min.mjs`, `model-en-mixed.bin` (MIT). |

El audio se enruta así: `voice-client.ts` → `setAudioChunkSink()` →
`controller.feedAudio()` → `head.streamAudio()`. Si el avatar no cargó, cae al
`AudioPlaybackQueue` original (audio sin lip-sync). El estado `speaking` lo
emiten los callbacks `onAudioStart/onAudioEnd` de TalkingHead.

El texto va por otro camino: `voice-client.ts` → `onTranscript(role, text)` →
(en `use-call-screen.ts`, solo `role === "model"`) → `controller.feedTranscript()`
→ `head.streamAudio({ visemes, vtimes, vdurations })`.

## Detalles que importan

- **Sincronía (lo que más cuesta acertar).** ⚠️ **Gemini envía el audio mucho
  más rápido que tiempo real.** Por eso `audioFedMs` ("cuánto audio nos han
  entregado") **no dice nada** sobre lo que se está oyendo ahora. Programar los
  visemas en tiempos absolutos derivados de ahí (vía
  `streamAudio({visemes, vtimes})`) falla: deja huecos muertos largos y llega a
  colocar formas después del final de la reproducción, donde nunca corren
  (síntoma: *"la boca deja de moverse a media frase"*).
  El diseño correcto **no programa, consume**: las formas se sostienen en orden,
  avanzan solo mientras hay audio reproduciéndose, y a un ritmo ajustado al
  audio que queda en el buffer (`backlogMs / bufferedMs`, acotado a 0.6–2.2×).
  Así las duraciones estimadas del texto solo tienen que ser correctas *en
  términos relativos*. Verificado por simulación: comportamiento idéntico con
  ráfagas de 1.2×, 5× y 20× tiempo real.
- **`playback-ended` NO significa "terminó el turno"** — se dispara en cualquier
  vaciado del buffer, también a media frase. Vaciar la cola de formas ahí es
  otra manera de cortar la frase por la mitad, así que el callback `onAudioEnd`
  deliberadamente **no** la toca.
- **⚠️ `streamAudio()` DESPRENDE el ArrayBuffer. Mide los bytes ANTES.**
  TalkingHead lo pasa al worklet con lista de transferencia
  (`postMessage(message, [message.data])`), así que `pcm.byteLength` queda en **0**
  al volver. Leerlo después dejaba `audioFedMs` clavado en 0 para siempre → el
  buffer calculado era 0 → el driver corría permanentemente a su techo (1.9x)
  **en todos los turnos en vivo**. Ese era el motivo real de que la boca fuera
  atropellada y desfasada, no la fórmula de ritmo. Ningún ajuste de la fórmula
  podía funcionar: su entrada estaba fijada en cero.
- **La posición de la boca es una FUNCIÓN PURA del reloj de reproducción.** Las
  formas salen del texto (como `__say`, que es el camino legible) y el tiempo sale
  de los ms de audio realmente **oídos**. En cada frame se pregunta "¿dónde va la
  reproducción y qué forma corresponde ahí?". Nada se acumula, así que nada puede
  derivar ni atascarse.
- **⚠️ El transcript es un cubrimiento CONTIGUO del audio del turno: ahí está la
  línea de tiempo. La hora de llegada NO lo es.** El fragmento N empieza donde
  terminó el habla del N−1, escalado por el tempo medido. Anclar cada fragmento a
  `audioFedMs` en el momento de su llegada parecía correcto y se degradaba turno
  adentro: Gemini genera audio en ráfagas cada vez más adelantadas respecto al
  transcript que lo describe, así que cada ancla caía más tarde que el habla a la
  que pertenecía, **y** el hueco entre anclas crecía, estirando cada fragmento
  hacia el techo de 2.5× (cámara lenta) y atrasando la boca todavía más. Dos
  errores que se componían fragmento a fragmento: *"inicia bien pero a medida que
  más habla se empieza a desfasar"*. `audioFedMs` sobrevive solo como **cota
  superior**: el transcript se genera A PARTIR del audio, así que no puede
  describir contenido más allá del audio ya generado.
- **El tempo solo es medible al FINAL del turno** (`endTurn`, en `turn_complete`):
  ahí el transcript está completo y `audioTotal / estTotal` es verdad de terreno.
  A mitad de turno no es medible en absoluto — el audio va en ráfagas muy por
  delante del transcript, así que `audioFedMs` es una cota, no una medición, y
  marcar el ritmo con ella es justo lo que producía la cámara lenta. Se guarda
  entre turnos con EMA rápida (0.6: la medición es exacta, no ruidosa; con 0.3
  tardaba cinco turnos en converger a una voz 40% más lenta y hasta entonces la
  boca se quedaba ~1 s muerta al final de cada turno). **El primer turno de la
  sesión no tiene calibración**; ahí es donde el fallback se gana el sueldo.
  Modelos descartados, todos con test de regresión: `backlog/buffered` (mide la
  ráfaga de Gemini, no el tempo), backlog a secas (un transcript entregado en
  bloque parece backlog enorme → sprint), ancla por hora de llegada y el ancla del
  fragmento siguiente como span (`anchor(N+1) − anchor(N)`: hereda la deriva de la
  ráfaga).
- **Un fragmento puede empezar legítimamente en el PASADO** — el transcript va
  detrás de la voz, así que parte de su habla ya se oyó. Se deja el ancla ahí y
  `tick` entra a mitad de fragmento: las formas que faltan siguen alineadas con la
  voz y las que ya pasaron se descartan, que es lo correcto. Solo cuando el
  fragmento entero quedó atrás se re-ancla al presente, para que la boca no se
  quede muerta. Snapear siempre al presente conserva las formas pero atrasa todo:
  alineación > completitud.
- **Velocidad del habla**: el Live API **no** expone ningún parámetro de
  velocidad (`speech_config` solo acepta `voice_config` y `language_code`), así
  que el único mecanismo es la instrucción del sistema en `server/prompt.py`.
  Importa para el lip-sync: voz más pausada = más tiempo por forma = labios más
  legibles. La calibración de arriba absorbe el cambio automáticamente.
- **Relevo con el fallback, con histéresis**: el texto conserva el control
  mientras le quede algo por decir (una forma nula durante una pausa entre
  palabras sigue siendo su turno, de ahí el guard `backlogMs > 0`). La cola
  también se seca un instante **entre fragmentos de transcript**, y saltar a
  HeadAudio en cada uno de esos huecos hacía que la boca se sintiera artificial y
  se trabara — intercambia dos drivers muy distintos varias veces por segundo. De
  ahí `HANDOVER_AFTER_DRY_MS = 900`: hace falta una sequía sostenida para ceder.
  Una boca en reposo un momento es mucho mejor que una boca dando manotazos.
- **La boca ya es geometría, no un sprite.** ⚠️ Histórico, por si vuelve a
  aparecer un avatar con la boca sellada: el modelo anterior no tenía cavidad
  bucal, así que se pintaba un canvas sobre un parche `MouthOverlay` para fingir
  la abertura. Ese camino ya no existe. El avatar del diseñador trae visemas
  reales sobre una boca modelada (dientes, encías, lengua) y `writeVisemeMorphs`
  los escribe directamente; ver [`fix_avatar_morphs.py`](../../../../scripts/avatar-rig-transfer/README.md)
  para lo que hay que parchear en cada entrega. [`lip-shapes.ts`](./lip-shapes.ts)
  sobrevive porque el driver sigue razonando en rasgos (apertura, anchura,
  redondez, protrusión, dientes visibles, altura de lengua), que es lo que hace
  falta para elegir visema: dibujando solo con *cuánto abre* y *cuán ancha* era
  **geométricamente imposible** separar /f/ de /s/, o /m/ de /p/ del silencio.
- **Grupos homófenos**: /t/, /d/, /n/, /l/ (y /θ/) se ven **igual** desde fuera —
  ni un lector de labios humano los separa. El test exige separación *entre*
  grupos, no dentro; pedir lo contrario sería pedir una mentira.
  Ojo: en este rig el parecido va más allá de la fonética. `diag_morph_distinct.py`
  mide coseno > 0.98 entre `jawOpen`, `viseme_aa`, `viseme_nn`, `viseme_TH`,
  `viseme_kk` y `viseme_SS` — las consonantes son el mismo gesto a distinta
  amplitud. Quedan cinco bocas realmente distintas: cerrada (`PP`), labiodental
  (`FF`), abierta (`aa`), estirada (`E`/`I`) y redondeada (`O`/`U`).
- **Probar los labios sin llamar a Gemini**: en la consola,
  `__sayTest("el manglar protege la costa")` mueve la boca con audio en
  silencio. `__hold("U")` fija un visema para inspeccionar su forma
  (`__hold(null)` lo libera). `__lipsyncLog()` imprime cada 250 ms qué fuente
  manda, la forma actual, lo pendiente en cola y el buffer de audio — úsalo para
  responder preguntas de sincronía con datos en vez de suposiciones.
  También está `__head`.
- **Tests** (`bun test src/` desde `web/`): la fonética española y el ritmo del
  driver son funciones puras, sin three.js ni DOM, precisamente para poder
  testearlos — el canvas en vivo no se puede verificar desde aquí.
  ⚠️ Dos parámetros hay que **barrer siempre**, porque fijarlos es lo que dejó
  pasar dos bugs de sincronía seguidos:
  1. **el burst de llegada del audio (1.2× a 50×)** — una simulación previa daba
     OK porque asumía que el audio llegaba al ritmo del habla, que es falso;
  2. **el retraso del transcript respecto a su audio (`textLagFrags`)** — la
     simulación entregaba cada fragmento exactamente en su posición de contenido,
     o sea daba por buena justo la hipótesis que causaba la deriva.
  El grupo *"staying in step for a whole turn"* mide la deriva **en ms**, no por
  actividad: cada fragmento lleva un visema distinto (`TAGS`), así que la forma
  sostenida identifica exactamente en qué fragmento va la boca. Muerde: volver al
  ancla por hora de llegada tumba 9 tests.
- **Tasa de muestreo**: `streamStart({ sampleRate: 24000 })` pone el
  `AudioContext` a 24 kHz; HeadAudio se construye con
  `processorOptions.sampleRate = audioCtx.sampleRate` y su filtro polifásico
  re-muestrea a 16 kHz internamente.
- **Vite**: `vite.config.ts` aliasa `three/addons/` → `three/examples/jsm/`
  (TalkingHead lo importa). HeadAudio se carga con `import(/* @vite-ignore */)`
  desde `public/` para no bundlearlo.
- **three**: fijado a `^0.185` (peer de TalkingHead es `^0.180`).

## Reemplazar el avatar

El avatar en producción es **`public/MANGLARIASK.glb`**: el personaje de la
fundación, entregado por el diseñador ya riggeado (esqueleto con nombres Mixamo
y 72 blend shapes ARKit + visemas Oculus propios). Cada entrega nueva pasa una
vez por [`scripts/avatar-rig-transfer/`](../../../../scripts/avatar-rig-transfer/README.md)
— auditar con `diag_morphs.py`, parchear con `fix_avatar_morphs.py`, verificar
en el navegador. Ahí está el detalle de qué se corrige y por qué.

`public/avatar1.glb` es un **Ready Player Me** (Wolf3D) que se conserva solo como
referencia de un rig correcto: útil para comparar contra una entrega dudosa
(`python probe_glb.py`). No se sirve. Para regenerarlo: crea un avatar en
[readyplayer.me](https://readyplayer.me) y descarga
`https://models.readyplayer.me/<ID>.glb?morphTargets=ARKit,Oculus%20Visemes`.

`body: "M"` / `body: "F"` en `avatar-controller.ts` selecciona el set de
animaciones corporales de TalkingHead, independientemente del GLB.

**Nota sobre Avaturn:** Los exports web de Avaturn (incluso "Avatar with animation")
no incluyen morph targets. Para usar Avaturn se necesita acceso a la API/SDK para
exportar con `morphTargets=ARKit,Oculus%20Visemes`.

## Actualizar HeadAudio

No está en npm. Re-descargar de
`https://raw.githubusercontent.com/met4citizen/HeadAudio/main/dist/`
(`headaudio.min.mjs`, `headworklet.min.mjs`, `model-en-mixed.bin`).
