# Avatar conversacional (TalkingHead + HeadAudio)

Cabeza 3D que habla con lip-sync en tiempo real y animaciones naturales
(parpadeo, movimiento de cabeza, contacto visual, respiración) sobre el flujo
de voz existente (Gemini Live).

## Por qué este stack

Gemini Live entrega **PCM crudo a 24 kHz sin visemas ni timestamps**. Por eso:

- **TalkingHead** (`@met4citizen/talkinghead`, npm) renderiza el avatar Ready
  Player Me, reproduce el PCM vía su streaming API y aporta las animaciones
  naturales integradas.
- **HeadAudio** (met4citizen, **no está en npm** → vendorizado en
  `public/headaudio/`) detecta visemas **desde el audio** (MFCC), independiente
  del idioma → funciona en español. Sus visemas Oculus mueven la boca.

## Piezas

| Archivo | Rol |
|---|---|
| [`avatar-controller.ts`](./avatar-controller.ts) | Envuelve TalkingHead + HeadAudio: `init()` carga el avatar; `startStream()` entra en streaming y conecta HeadAudio; `feedAudio()` recibe PCM; `setState()` mapea idle/listening/thinking/speaking a gaze. |
| [`avatar.tsx`](./avatar.tsx) | Componente React: monta el canvas de TalkingHead, muestra `avatar.png` como fallback hasta cargar. |
| [`talkinghead.d.ts`](./talkinghead.d.ts) | Tipos mínimos para la librería (no trae tipos). |
| `public/avatar1.glb` | Avatar Ready Player Me (Wolf3D). Tiene `Armature`, 72 morph targets: visemas Oculus + ARKit blendshapes + huesos de ojos. |
| `public/headaudio/*` | `headaudio.min.mjs`, `headworklet.min.mjs`, `model-en-mixed.bin` (MIT). |

El audio se enruta así: `voice-client.ts` → `setAudioChunkSink()` →
`controller.feedAudio()` → `head.streamAudio()`. Si el avatar no cargó, cae al
`AudioPlaybackQueue` original (audio sin lip-sync). El estado `speaking` lo
emiten los callbacks `onAudioStart/onAudioEnd` de TalkingHead.

## Detalles que importan

- **Tasa de muestreo**: `streamStart({ sampleRate: 24000 })` pone el
  `AudioContext` a 24 kHz; HeadAudio se construye con
  `processorOptions.sampleRate = audioCtx.sampleRate` y su filtro polifásico
  re-muestrea a 16 kHz internamente.
- **Vite**: `vite.config.ts` aliasa `three/addons/` → `three/examples/jsm/`
  (TalkingHead lo importa). HeadAudio se carga con `import(/* @vite-ignore */)`
  desde `public/` para no bundlearlo.
- **three**: fijado a `^0.185` (peer de TalkingHead es `^0.180`).

## Reemplazar el avatar

El avatar actual es de **Ready Player Me** (Wolf3D). Para cambiarlo:

1. Crea un avatar en [readyplayer.me](https://readyplayer.me) y copia el ID.
2. Descarga: `https://models.readyplayer.me/<ID>.glb?morphTargets=ARKit,Oculus%20Visemes`
3. Reemplaza `public/avatar1.glb` con el archivo descargado.
4. Ajusta `body: "M"` o `body: "F"` en `avatar-controller.ts` según el género.

**Nota sobre Avaturn:** Los exports web de Avaturn (incluso "Avatar with animation")
no incluyen morph targets. Para usar Avaturn se necesita acceso a la API/SDK para
exportar con `morphTargets=ARKit,Oculus%20Visemes`.

## Actualizar HeadAudio

No está en npm. Re-descargar de
`https://raw.githubusercontent.com/met4citizen/HeadAudio/main/dist/`
(`headaudio.min.mjs`, `headworklet.min.mjs`, `model-en-mixed.bin`).
