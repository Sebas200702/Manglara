# Avatar tooling

Headless Blender/Python tools for the Manglara avatar served at
`web/public/MANGLARIASK.glb`.

The folder is named after the pipeline it used to hold: a rig *transfer* that
took a static AI-generated mesh (Tripo) plus a TalkingHead reference avatar
(Ready Player Me) and grafted a Mixamo armature, skin weights and 72 blend
shapes onto it. That pipeline is retired — the designer now delivers the
character already rigged, with its own facial blend shapes and a Mixamo-named
skeleton, so there is nothing left to transfer. What remains here is the much
smaller job of auditing that delivery and patching the handful of things it
gets wrong.

`.gitignore` treats this folder as an allowlist. Only the files below are
tracked; anything else you drop here (one-off probes, GLB iterations, render
sheets) stays local. That is deliberate — the retired pipeline accumulated
~1.4 GB of derived output and about forty single-use debugging scripts.

## Files

| File | Purpose |
|---|---|
| `fix_avatar_morphs.py` | Repair pass 1: blend shapes. Run on every new delivery. |
| `add_hair_bones.py` | Repair pass 2: fits a bone chain to each braid so it can swing. |
| `remove_zfight_layer.py` | Repair pass 3: deletes coplanar duplicate surfaces (the shimmering dress). |
| `fix_rig_scale.py` | Repair pass 4: aligns hip height and foot placement to TalkingHead's reference frame. |
| `fix_skirt_weights.py` | Repair pass 5: re-anchors the garment off the leg and hip bones. |
| `diag_skirt_weights.py` | Which bones drive the skirt, split above/below the waist. |
| `diag_morphs.py` | Per-primitive blend-shape audit: which targets are live, which are all-zero, how far they move, sparse or dense. |
| `diag_morph_distinct.py` | Are the visemes actually different shapes? Pairwise cosine similarity plus mouth-aperture metrics. |
| `diag_hair_bones.py` | Checks the braid chains exist, are parented, and carry real weights. |
| `probe_glb.py` | Fast inventory — meshes, morph names, materials, vertex colours. No Blender needed. |
| `probe_hair.py` / `probe_beads.py` | Locate the braids and their tip beads before fitting bones. |
| `qa_render.py` | Renders the avatar through TalkingHead's own camera maths, one image per morph. |
| `soften_dress_texture.py` | Tones down the dress texture contrast. |

The `probe_glb.py` / `diag_*.py` scripts are plain Python — they parse the GLB
container directly, so they run without Blender.

## Processing a new delivery

```bash
python diag_morphs.py "C:/Users/sebas/Downloads/NEW.glb"
```

Read the per-primitive summary first. A target reported `DEAD` on the skin
primitive is genuinely missing; `viseme_sil` is *expected* to be dead, since it
is the rest pose. Then run the two passes in order — hair bones second, because
`fix_avatar_morphs.py` re-exports the whole file:

```bash
blender -b -noaudio -P fix_avatar_morphs.py -- --glb "C:/Users/sebas/Downloads/NEW.glb" --out /tmp/step1.glb --teeth-scale 0.85 --teeth-back 0.006
```

```bash
blender -b -noaudio -P add_hair_bones.py -- --glb /tmp/step1.glb --out /tmp/step2.glb
```

```bash
blender -b -noaudio -P remove_zfight_layer.py -- --glb /tmp/step2.glb --out /tmp/step3.glb
```

```bash
blender -b -noaudio -P fix_rig_scale.py -- --glb /tmp/step3.glb --out /tmp/step4.glb
```

```bash
blender -b -noaudio -P fix_skirt_weights.py -- --glb /tmp/step4.glb --out ../../web/public/MANGLARIASK.glb
```

Order matters for the last two: `fix_skirt_weights.py` must run after
`fix_rig_scale.py`, because scaling re-exports the whole file.

Run `add_hair_bones.py --dry-run` first on an unfamiliar delivery: it prints
which mesh each captured vertex came from. Only the hair mesh should appear. If
skin, shirt or sash vertices show up, the braid cylinder is too wide and
re-weighting them onto a swinging bone will tear the body open.

## What the repair pass does

Three fixes, plus a re-export. It does not touch the skeleton, the weights, the
materials or the topology.

1. **The brow mesh follows the face.** The designer's `cejas` primitive only
   carries three live keys (`browDownLeft/Right`, `browInnerUp`); every other
   expression moves the skin while the brow geometry stays put — most visibly
   `browOuterUp`, which the app drives for speech emphasis. Each brow vertex
   takes an inverse-distance blend of its four nearest skin vertices' deltas,
   for all 72 keys.
2. **`eyesLookUp` / `eyesLookDown` filled in.** Both arrive all-zero, but
   TalkingHead's mood table drives them by name (`eyesLookUp:[.2]`,
   `eyesLookDown:.1`). They are exactly the sum of the per-eye keys, which do
   exist.
3. **The dental assembly is reseated.** It sits about a centimetre behind the
   lip surface and is as tall as the mouth opening, so a small aperture
   (`viseme_O`, `viseme_U`) fills with two rows of bright teeth instead of a
   dark cavity. Scaled about its own centroid and pushed back along glTF -Z.

The re-export stores morph deltas in **sparse** accessors. Only ~11 % of the
skin's 30 543 vertices move per key and the source stores every zero densely:
58 MB of the original 79.6 MB is zeroes. Result: **79.6 MB → 23.3 MB**, with no
geometry, no textures and no morph targets lost. Per-target NORMAL deltas are
dropped as part of that (pass `--morph-normals` to keep them); on this
soft-shaded stylised character the difference is not visible.

## What the hair pass does

The designer skins both braids rigidly to `Head`, so they are welded to the
skull. `add_hair_bones.py` finds each braid geometrically (a tight cylinder
around its axis, below the head joint and off the midline — *not* by mesh name,
since the tip beads could easily have lived on another mesh), fits a three-bone
chain to it, and blends the braid vertices from `Head` onto that chain, keeping
`Head` in control of the top 30 % so the root cannot detach.

Three bones, not two: DynamicBones rotates the **parent** of the bone you
configure, so an entry for `HairL1` would swing the skull itself. The app
configures bones 2 and 3, which articulate bones 1 and 2. See
`HAIR_DYNAMIC_BONES` in `avatar-controller.ts` for the spring constants.

## What the z-fight pass does

The dress ships as two meshes: the whole garment, plus a copy of just the torso
with *different UVs*, laid on top as a pattern overlay. Every vertex of the copy
sits at exactly the same position as the base (measured: 100 % within 0.5 mm),
both are opaque and double-sided, and there is no polygon offset — so the depth
test picks a different surface per pixel per frame and the torso shimmers. The
overlay is simply lost; deleting it costs nothing visually and stops the flicker.

The pass is generic: it removes any mesh whose vertices coincide with another
mesh sharing a material. `--dry-run` prints the coincidence percentage per pair
so you can see what it would remove; the eyes, which share the `ojos` material
but sit apart, score 0 %.

## What the lower-body passes do

Three separate faults made the legs and skirt look broken while the head looked
fine. All three are mismatches with TalkingHead's reference skeleton, not
defects in the model — render it at rest with `qa_render.py` and the skirt is a
clean bell.

1. **Hip height.** Pose templates hardcode `Hips.position.y = 1`. This rig's
   hips sat at 0.908 m, so the library lifted them and its per-frame hip-feet
   balance pulled them back down by stretching the legs. Fixed by scaling.
2. **Feet placement.** The same balance loop slides the hips backwards until the
   toes sit over the origin. These toes stood 13 cm forward, so it rammed the
   waist ~9 cm back and the torso leaned over the legs. Fixed by re-centring.
3. **The `Hips` rest rotation.** This is the one that threw the skirt out
   backwards like a bustle. `Hips` has a −93° X rest rotation here; the pose
   templates *assign* it a near-identity rotation rather than composing with the
   bind, so everything weighted to `Hips` swings 90°. The body survives because
   it hangs off the `Spine` chain, whose rest orientation does match the
   templates. So the garment is anchored to `Spine`, never `Hips`.

Point 3 is worth remembering: **do not weight anything to `Hips` on this rig.**
Measure with `diag_skirt_weights.py`, and confirm in-engine by sampling
`skinnedMesh.applyBoneTransform` on the hem — if the per-vertex displacement
varies by more than a centimetre or two across the hem, it is rotating, not
translating, and something is anchored wrong.

## Verifying

```bash
python diag_morphs.py ../../web/public/MANGLARIASK.glb
python diag_morph_distinct.py ../../web/public/MANGLARIASK.glb
python diag_hair_bones.py ../../web/public/MANGLARIASK.glb
blender -b -noaudio -P qa_render.py -- --glb ../../web/public/MANGLARIASK.glb --outdir renders/check --morphs "jawOpen,viseme_O,viseme_PP,browOuterUpLeft,eyesClosed"
```

Judge the mouth **in the app**, not from the Blender renders. EEVEE lights the
inside of the mouth far more brightly than the app's environment does, which
makes every open viseme look like a mouthful of teeth. In the browser the same
frames read correctly. `window.__hold('aa')` pins a viseme on the live avatar;
`window.__hold(null)` releases it.

## Known limitations, not bugs

- **The consonant visemes are one gesture at different amplitudes.**
  `diag_morph_distinct.py` reports cosine similarity above 0.98 between
  `jawOpen`, `viseme_aa`, `viseme_nn`, `viseme_TH`, `viseme_kk` and `viseme_SS`.
  Five mouth shapes are genuinely distinguishable: closed (`PP`), labiodental
  (`FF`), open (`aa`), spread (`E`/`I`) and rounded (`O`/`U`). Distinguishing
  the rest would take remodelling, not a script. The app's viseme driver picks
  from those same categories, so it costs little in practice.
- **`tongueOut` is dead.** There is tongue geometry, but no key drives it.
  TalkingHead never uses it here.
