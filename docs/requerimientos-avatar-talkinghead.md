# Requerimientos técnicos: adaptación de personaje 3D para avatar conversacional (TalkingHead)

**Proyecto:** Manglara — avatar 3D con lip-sync en tiempo real (web)
**Motor:** [TalkingHead de met4citizen](https://github.com/met4citizen/TalkingHead) sobre three.js (WebGL, navegador)
**Fecha:** 2026-07-14

---

## 1. Contexto

La aplicación renderiza un avatar 3D en el navegador que habla en español con
sincronización labial generada por audio en tiempo real. La librería TalkingHead
está diseñada para avatares **Ready Player Me (RPM / Wolf3D)** y valida en tiempo
de carga la presencia de un esqueleto y un set de blend shapes específicos. Si
falta cualquier elemento requerido, la carga falla con error.

Se desea reemplazar el avatar actual por el personaje del archivo
**`3d character model.glb`** (entregado aparte).

## 2. Estado actual del modelo entregado

Diagnóstico del archivo (generado con Tripo, IA imagen→3D):

| Propiedad | Valor actual | Problema |
|---|---|---|
| Geometría | 1 malla única, 1.011.990 vértices / 1.967.952 triángulos | Excesivo para web en tiempo real; requiere retopología |
| Esqueleto | **Ninguno** (0 skins, 0 huesos) | Requiere rigging completo |
| Skinning | Ninguno | Requiere pesado de vértices |
| Blend shapes (morph targets) | **0** | Requiere esculpir el set facial completo |
| Animaciones | 0 | No se necesitan (la librería anima proceduralmente) |
| Material | 1 material PBR (baseColor, metallicRoughness, normal) | OK, conservar |
| Peso del archivo | 57,8 MB | Objetivo: ≤ 10 MB |

**Referencia funcional:** el avatar RPM actual en producción tiene 8.026 vértices /
13.317 triángulos en 10 mallas y pesa 4,7 MB.

## 3. Entregable

Un único archivo **glTF 2.0 binario (.glb)** con el personaje riggeado, pesado y
con blend shapes, que cargue sin errores en TalkingHead. Sin animaciones horneadas.

## 4. Requerimientos

### 4.1 Geometría (retopología)

- Retopologizar a un presupuesto de **15.000–50.000 triángulos** en total.
- Malla de la **cabeza separada** (o al menos con topología limpia): edge loops
  concéntricos alrededor de boca y ojos, suficiente densidad para deformación
  facial (los visemas y expresiones se hacen con blend shapes sobre esta malla).
- **Interior de boca obligatorio**: dientes (superior/inferior) y lengua como
  geometría, idealmente en malla aparte (en RPM: `Wolf3D_Teeth`). Sin esto,
  `jawOpen` y los visemas muestran un hueco vacío.
- **Ojos como mallas separadas** (una por ojo), esféricas, para poder rotarlas
  con los huesos `LeftEye`/`RightEye` (contacto visual procedural).
- UVs limpias; conservar/re-hornear las texturas existentes (baseColor, normal,
  metallicRoughness) a máximo 2K, formato JPEG o PNG embebido.

### 4.2 Esqueleto (obligatorio, la librería valida cada hueso por nombre)

- Jerarquía y **nombres exactos de Mixamo sin prefijo** (convención Ready Player
  Me). El objeto armature raíz **debe llamarse `Armature`** (exacto,
  case-sensitive) y todas las mallas deben ser hijas de él, sin nodos
  contenedores/empties intermedios.
- Huesos requeridos (la carga falla si falta cualquiera):
  - Tronco: `Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`
  - Ojos: `LeftEye`, `RightEye` (usados para la mirada; su ausencia rompe la librería)
  - Brazos: `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand` (+ lado derecho)
  - Manos: **5 dedos × 3 falanges por mano**, p. ej. `LeftHandThumb1..3`,
    `LeftHandIndex1..3`, `LeftHandMiddle1..3`, `LeftHandRing1..3`,
    `LeftHandPinky1..3` (+ lado derecho). Aunque el personaje se muestre en
    plano medio, la librería posa los dedos y valida su existencia.
  - Piernas: `LeftUpLeg`, `LeftLeg`, `LeftFoot`, `LeftToeBase` (+ lado derecho)
- **Crítico — orientación de reposo:** no basta con los nombres. La librería
  escribe rotaciones locales absolutas capturadas de un esqueleto RPM, por lo
  que los **roll/rest orientations de cada hueso deben coincidir con la
  convención Mixamo/RPM**. Con un rig de orientaciones distintas los brazos se
  contorsionan. Recomendación: auto-rig con Mixamo (y renombrar quitando el
  prefijo `mixamorig:`) o transferir el esqueleto de un avatar RPM existente.
  Pose de reposo: T-pose estándar RPM.

### 4.3 Skinning

- Pesos suaves, máximo 4 influencias por vértice (estándar glTF).
- Los ojos pesados 100 % a `LeftEye`/`RightEye`; dientes superiores a `Head`,
  mandíbula/dientes inferiores acompañan la apertura vía blend shape (no hay
  hueso de mandíbula en RPM: la boca se abre con `jawOpen` como morph).

### 4.4 Blend shapes / morph targets (obligatorio)

Sobre la malla de la cabeza (y dientes/lengua donde aplique), con **nombres
exactos, case-sensitive**. La librería referencia todo el set en runtime
(parpadeo, mirada, expresiones, ruido idle); un morph faltante produce fallos.

**A. Visemas Oculus (15) — indispensables para el lip-sync:**
`viseme_aa`, `viseme_E`, `viseme_I`, `viseme_O`, `viseme_U`, `viseme_PP`,
`viseme_SS`, `viseme_TH`, `viseme_DD`, `viseme_FF`, `viseme_kk`, `viseme_nn`,
`viseme_RR`, `viseme_CH`, `viseme_sil`

**B. Set facial ARKit (52):**
`browDownLeft`, `browDownRight`, `browInnerUp`, `browOuterUpLeft`,
`browOuterUpRight`, `cheekPuff`, `cheekSquintLeft`, `cheekSquintRight`,
`eyeBlinkLeft`, `eyeBlinkRight`, `eyeLookDownLeft`, `eyeLookDownRight`,
`eyeLookInLeft`, `eyeLookInRight`, `eyeLookOutLeft`, `eyeLookOutRight`,
`eyeLookUpLeft`, `eyeLookUpRight`, `eyeSquintLeft`, `eyeSquintRight`,
`eyeWideLeft`, `eyeWideRight`, `jawForward`, `jawLeft`, `jawOpen`, `jawRight`,
`mouthClose`, `mouthDimpleLeft`, `mouthDimpleRight`, `mouthFrownLeft`,
`mouthFrownRight`, `mouthFunnel`, `mouthLeft`, `mouthLowerDownLeft`,
`mouthLowerDownRight`, `mouthPressLeft`, `mouthPressRight`, `mouthPucker`,
`mouthRight`, `mouthRollLower`, `mouthRollUpper`, `mouthShrugLower`,
`mouthShrugUpper`, `mouthSmileLeft`, `mouthSmileRight`, `mouthStretchLeft`,
`mouthStretchRight`, `mouthUpperUpLeft`, `mouthUpperUpRight`, `noseSneerLeft`,
`noseSneerRight`, `tongueOut`

**C. Extras RPM (5) — opcionales** (la librería los sintetiza si faltan, pero se
agradecen): `mouthOpen`, `mouthSmile`, `eyesClosed`, `eyesLookUp`, `eyesLookDown`

Notas:
- Los visemas y ARKit de boca deben esculpirse con calidad; la prioridad
  artística es la zona de la boca (es un avatar que habla en primer plano).
- Herramientas sugeridas en Blender: addon **Faceit** (genera ARKit + visemas),
  o esculpido manual partiendo de la referencia de RPM.
- El exportador de Blender incluye los nombres en `extras.targetNames`
  automáticamente; verificar que la opción de shape keys esté activa.

### 4.5 Transformaciones y exportación

- Exportar **.glb (glTF 2.0)**, convención **+Y up** (opción por defecto del
  exportador de Blender).
- Escala real en metros: personaje de ~1,60–1,80 m de altura, de pie sobre el
  origen (pies en Y=0), mirando a +Z.
- **Todas las transformaciones aplicadas/congeladas** (rotación 0, escala 1 en
  todos los nodos). Ningún empty ni nodo wrapper por encima de `Armature`: la
  librería re-parenta `Armature` directamente a su escena y cualquier
  transformación en nodos padre se pierde (el avatar aparece flotando o
  acostado).
- Sin pistas de animación. Texturas embebidas en el .glb.
- Peso final objetivo: **≤ 10 MB**.

## 5. Criterios de aceptación

1. El .glb carga en TalkingHead sin lanzar `Avatar object <hueso> not found` ni
   `Blend shapes not found`.
2. En reposo el personaje se ve de pie, en pose natural, brazos a los lados y
   sin contorsiones de extremidades (valida la orientación del rig).
3. Al reproducir audio, los visemas se activan visiblemente (prueba: mover
   manualmente los sliders `viseme_*` de 0 a 1 en Blender debe verse correcto y
   sin roturas de malla).
4. Parpadeo (`eyeBlinkLeft/Right`) cierra los párpados completamente sin
   atravesar el globo ocular.
5. Rotar los huesos `LeftEye`/`RightEye` ±15° mueve la mirada sin artefactos.
6. Rendimiento: ≤ 50k triángulos, ≤ 10 MB, texturas ≤ 2K.

Una prueba rápida de compatibilidad la puede hacer el propio artista cargando el
.glb en el demo de TalkingHead o enviándonos una versión preliminar (podemos
validarla en el entorno local del proyecto antes de la entrega final).

## 6. Referencia

- Librería: https://github.com/met4citizen/TalkingHead (README, sección *Avatars*)
- Un avatar RPM válido de ejemplo (con los 72 morphs y el esqueleto exacto) se
  puede descargar en https://readyplayer.me creando un avatar y agregando a la
  URL del .glb: `?morphTargets=ARKit,Oculus%20Visemes&textureAtlas=1024`
  — sirve como plantilla de nombres de huesos, morphs y estructura.
