"""Repair the facial blend shapes of the designer avatar and re-export it lean.

Run headless:
  blender -b -noaudio -P fix_avatar_morphs.py -- --glb <in.glb> --out <out.glb>

Three fixes, all verified by diag_morphs.py / diag_morph_distinct.py afterwards:

1. Eyebrow mesh follows the face. The `cejas` primitive only carried three live
   shape keys (browDown L/R, browInnerUp); every other expression - including
   browOuterUp - moved the skin underneath while the brow geometry stayed put.
   Each brow vertex now takes an inverse-distance blend of its nearest skin
   vertices' deltas, for all 72 keys, so the brows ride the face everywhere.

2. `eyesLookUp` / `eyesLookDown` synthesised from the split per-eye keys. Both
   arrive all-zero from the designer but TalkingHead's mood table drives them by
   name (`eyesLookUp:[.2]`, `eyesLookDown:.1`), so the aggregate look cues were
   dead. They are exactly eyeLook{Up,Down}Left + eyeLook{Up,Down}Right.

3. Dental assembly pushed back along -Z (glTF forward). It sat ~10 mm behind the
   lip surface, so a small aperture (viseme_O / _U) showed nothing but two rows
   of bright teeth instead of a dark cavity.

Export uses sparse shape-key accessors: only ~11% of the skin's 30k vertices move
per key, and the source file stored every zero densely (58 MB of the 79 MB).
"""
import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector, kdtree

BROW_MAT = "cejas"        # substring match on the material name
SKIN_MAT = "piel"
TEETH_MAT = "Material.002"
KNN = 4


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--out", required=True)
    # glTF -Z is "into the head"; Blender is Z-up so this becomes +Y there.
    p.add_argument("--teeth-back", type=float, default=0.005)
    p.add_argument("--teeth-scale", type=float, default=1.0,
                   help="uniform scale of the dental assembly about its own "
                        "centroid; <1 leaves more dark cavity in small apertures")
    p.add_argument("--morph-normals", action="store_true",
                   help="keep per-target NORMAL deltas (doubles morph payload)")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)


def slot_of_vertex(obj):
    """material_index per vertex (glTF primitives never share vertices)."""
    mesh = obj.data
    out = [-1] * len(mesh.vertices)
    for poly in mesh.polygons:
        for vi in poly.vertices:
            out[vi] = poly.material_index
    return out


def find_slot(obj, needle):
    for i, ms in enumerate(obj.material_slots):
        if ms.material and needle.lower() in ms.material.name.lower():
            return i
    return -1


def fix_brows(obj, vslot, brow_slot, skin_slot):
    mesh = obj.data
    keys = obj.data.shape_keys.key_blocks
    basis = keys[0]
    skin_ids = [i for i, s in enumerate(vslot) if s == skin_slot]
    brow_ids = [i for i, s in enumerate(vslot) if s == brow_slot]
    if not skin_ids or not brow_ids:
        print("  [brows] SKIPPED - slots not found")
        return

    kd = kdtree.KDTree(len(skin_ids))
    for j, vi in enumerate(skin_ids):
        kd.insert(basis.data[vi].co, j)
    kd.balance()

    # Precompute the donor set once; it is the same for every shape key.
    donors = []
    for vi in brow_ids:
        hits = kd.find_n(basis.data[vi].co, KNN)
        ws = [1.0 / max(d, 1e-4) ** 2 for (_, _, d) in hits]
        tot = sum(ws) or 1.0
        donors.append((vi, [(skin_ids[j], w / tot) for (_, j, _), w in zip(hits, ws)]))
    span = max(h[2] for vi in brow_ids
               for h in [kd.find_n(basis.data[vi].co, 1)[0]])
    print(f"  [brows] {len(brow_ids)} brow verts <- {len(skin_ids)} skin verts, "
          f"worst donor distance {span * 1000:.1f} mm")

    changed = 0
    for kb in keys[1:]:
        for vi, ds in donors:
            d = Vector((0.0, 0.0, 0.0))
            for sj, w in ds:
                d += (kb.data[sj].co - basis.data[sj].co) * w
            if d.length > 1e-6:
                changed += 1
            kb.data[vi].co = basis.data[vi].co + d
    print(f"  [brows] wrote {changed} non-zero brow deltas across {len(keys) - 1} keys")


def synth_eye_aggregates(obj):
    keys = obj.data.shape_keys.key_blocks
    basis = keys[0]
    pairs = [("eyesLookUp", "eyeLookUpLeft", "eyeLookUpRight"),
             ("eyesLookDown", "eyeLookDownLeft", "eyeLookDownRight")]
    for target, a, b in pairs:
        if target not in keys or a not in keys or b not in keys:
            print(f"  [eyes] SKIPPED {target} - missing source key")
            continue
        ka, kb_, kt = keys[a], keys[b], keys[target]
        moved = 0
        for i in range(len(basis.data)):
            base = basis.data[i].co
            d = (ka.data[i].co - base) + (kb_.data[i].co - base)
            kt.data[i].co = base + d
            if d.length > 1e-6:
                moved += 1
        print(f"  [eyes] {target} = {a} + {b} -> {moved} verts move")


def reseat_teeth(obj, vslot, teeth_slot, amount, scale):
    """Shrink about the assembly centroid, then push back. glTF -Z == Blender +Y.

    Scaling the shape-key coordinates alongside the base scales the jaw-drop
    deltas by the same factor, which is what we want: smaller teeth should
    travel proportionally less.
    """
    if teeth_slot < 0 or (amount <= 0 and scale == 1.0):
        print("  [teeth] skipped")
        return
    mesh = obj.data
    keys = obj.data.shape_keys.key_blocks
    ids = [i for i, s in enumerate(vslot) if s == teeth_slot]
    center = Vector((0.0, 0.0, 0.0))
    for vi in ids:
        center += mesh.vertices[vi].co
    center /= len(ids)
    off = Vector((0.0, amount, 0.0))
    for vi in ids:
        mesh.vertices[vi].co = center + (mesh.vertices[vi].co - center) * scale + off
        for kb in keys:
            kb.data[vi].co = center + (kb.data[vi].co - center) * scale + off
    print(f"  [teeth] {len(ids)} verts scaled x{scale:.2f} about centroid, "
          f"moved {amount * 1000:.0f} mm back (glTF -Z)")


def main():
    args = parse_args()
    clear()
    bpy.ops.import_scene.gltf(filepath=args.glb)

    obj = None
    for o in bpy.data.objects:
        if o.type == "MESH" and o.data.shape_keys:
            if obj is None or len(o.data.vertices) > len(obj.data.vertices):
                obj = o
    if obj is None:
        raise RuntimeError("no mesh with shape keys found")
    keys = obj.data.shape_keys.key_blocks
    print(f"target object '{obj.name}': {len(obj.data.vertices)} verts, "
          f"{len(keys) - 1} shape keys, slots="
          f"{[ms.material.name if ms.material else None for ms in obj.material_slots]}")

    vslot = slot_of_vertex(obj)
    brow = find_slot(obj, BROW_MAT)
    skin = find_slot(obj, SKIN_MAT)
    teeth = find_slot(obj, TEETH_MAT)
    for nm, s in (("brow", brow), ("skin", skin), ("teeth", teeth)):
        n = sum(1 for x in vslot if x == s)
        print(f"  slot {nm}={s} ({n} verts)")

    fix_brows(obj, vslot, brow, skin)
    synth_eye_aggregates(obj)
    reseat_teeth(obj, vslot, teeth, args.teeth_back, args.teeth_scale)

    # Every key must rest at 0 or the exported base pose is deformed.
    for kb in keys[1:]:
        kb.value = 0.0

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=args.out,
        export_format="GLB",
        export_morph=True,
        export_morph_normal=args.morph_normals,
        export_morph_tangent=False,
        # only stores vertices that actually move - the whole point of this pass
        export_try_sparse_sk=True,
        export_skins=True,
        export_yup=True,
        export_animations=False,
        export_apply=False,
    )
    size = Path(args.out).stat().st_size / 1e6
    print(f"exported {args.out} ({size:.1f} MB)")


if __name__ == "__main__":
    main()
