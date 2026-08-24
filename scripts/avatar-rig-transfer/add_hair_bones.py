"""Fit a bone chain to each hanging braid so TalkingHead can swing it.

The designer rig has no hair bones: the braids are skinned rigidly to `Head`, so
they are welded to the skull and read as plastic whenever she moves. This adds a
short chain per braid, re-weights the braid vertices onto it, and leaves the rest
of the rig untouched. TalkingHead's DynamicBones module then drives them - see
`modelDynamicBones` in avatar-controller.ts.

Run AFTER fix_avatar_morphs.py, on its output:

  blender -b -noaudio -P add_hair_bones.py -- --glb <fixed.glb> --out <final.glb>
  blender -b -noaudio -P add_hair_bones.py -- --glb <fixed.glb> --dry-run

Blender is Z-up but glTF is Y-up, so "down the braid" is -Z in here and -Y in the
exported file. The braid is found geometrically rather than by mesh name, because
the tip beads live on a different mesh (`Sphere.001`, the necklace material) than
the braid itself (`cabello 2`) and both have to move together.
"""
import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector

# Braid search volume, in metres, relative to the Head joint.
BRAID_MIN_ABS_X = 0.055   # off the midline: excludes the face and neck
# The braid itself measures ~0.018 across; the tip beads bulge wider. Kept tight
# on purpose: at 0.055 the cylinder also swallowed jaw skin, collar and sash
# vertices, and re-weighting those onto a swinging bone tears the face open.
BRAID_RADIUS = 0.034
# How far below the hair geometry the tip beads may sit.
TIP_MARGIN = 0.025
# Only hair and bead materials may be re-weighted. A geometric test alone is not
# enough - the necklace shares the bead material and passes close to the braid.
BRAID_MATERIALS = ("pelo", "collar")
# Three, not two. DynamicBones rotates the PARENT of the bone you configure
# ("link updates only the parent's quaternions"), so a config item for HairL1
# would swing the Head itself. With three, items on HairL2/HairL3 articulate
# HairL1/HairL2 and the skull is never touched.
BONES_PER_BRAID = 3
# How far down the braid the Head bone keeps full control. Without this the root
# of the braid detaches from the skull when the chain swings.
ROOT_BLEND = 0.3


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--out")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def clamp01(x):
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def find_braid_axis(hair_obj, head_z):
    """Centre (x, y) and z extent of each braid, from the hair mesh alone."""
    mw = hair_obj.matrix_world
    out = {}
    for label, sign in (("L", -1), ("R", 1)):
        pts = [
            mw @ v.co for v in hair_obj.data.vertices
            if (mw @ v.co).z < head_z
            and (sign * (mw @ v.co).x) > BRAID_MIN_ABS_X
        ]
        if len(pts) < 20:
            print(f"  [{label}] only {len(pts)} candidate verts - skipping")
            continue
        cx = sum(p.x for p in pts) / len(pts)
        cy = sum(p.y for p in pts) / len(pts)
        out[label] = {
            "x": cx, "y": cy,
            "top": max(p.z for p in pts),
            "bottom": min(p.z for p in pts),
            "n_hair": len(pts),
        }
    return out


def is_braid_material(obj):
    return any(
        ms.material and any(m in ms.material.name.lower() for m in BRAID_MATERIALS)
        for ms in obj.material_slots
    )


def collect_braid_verts(axis, objects):
    """Hair/bead vertices inside the braid cylinder, from any mesh."""
    got = {}
    for obj in objects:
        if not is_braid_material(obj):
            continue
        mw = obj.matrix_world
        hits = []
        for i, v in enumerate(obj.data.vertices):
            w = mw @ v.co
            if w.z > axis["top"] + 1e-4 or w.z < axis["bottom"] - TIP_MARGIN:
                continue
            if Vector((w.x - axis["x"], w.y - axis["y"], 0)).length > BRAID_RADIUS:
                continue
            hits.append((i, w))
        if hits:
            got[obj.name] = hits
    return got


def build_chain(arm_obj, label, axis, tip_z):
    """Create the bone chain in armature space and return the bone names."""
    inv = arm_obj.matrix_world.inverted()
    top, bottom = axis["top"], tip_z
    names = []
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_obj.data.edit_bones
    parent = eb.get("Head")
    for k in range(BONES_PER_BRAID):
        z0 = top + (bottom - top) * k / BONES_PER_BRAID
        z1 = top + (bottom - top) * (k + 1) / BONES_PER_BRAID
        name = f"Hair{label}{k + 1}"
        b = eb.new(name)
        b.head = inv @ Vector((axis["x"], axis["y"], z0))
        b.tail = inv @ Vector((axis["x"], axis["y"], z1))
        b.parent = parent
        # The first bone hangs off the skull at an offset, so it must not be
        # connected; the rest form a continuous chain.
        b.use_connect = k > 0
        parent = b
        names.append(name)
    bpy.ops.object.mode_set(mode="OBJECT")
    return names


def weight_braid(obj, hits, bone_names, axis, tip_z):
    """Blend each captured vertex from Head onto the chain, top to bottom."""
    groups = {}
    for n in bone_names + ["Head"]:
        groups[n] = obj.vertex_groups.get(n) or obj.vertex_groups.new(name=n)
    span = max(axis["top"] - tip_z, 1e-6)
    n = len(bone_names)
    for idx, w in hits:
        t = clamp01((axis["top"] - w.z) / span)
        head_w = clamp01(1.0 - t / ROOT_BLEND)
        chain_w = 1.0 - head_w
        # Position along the chain, in bone-centre units.
        s = t * n
        weights = [0.0] * n
        if s <= 0.5:
            weights[0] = 1.0
        elif s >= n - 0.5:
            weights[-1] = 1.0
        else:
            lo = int(s - 0.5)
            f = s - 0.5 - lo
            weights[lo] = 1.0 - f
            weights[lo + 1] = f

        # Drop every existing influence first: these vertices arrive rigidly
        # bound to Head (and sometimes Neck), and leaving those in place would
        # fight the chain and blow past the 4-influence glTF limit.
        for vg in obj.vertex_groups:
            try:
                vg.remove([idx])
            except RuntimeError:
                pass
        if head_w > 1e-4:
            groups["Head"].add([idx], head_w, "REPLACE")
        for bn, bw in zip(bone_names, weights):
            if bw * chain_w > 1e-4:
                groups[bn].add([idx], bw * chain_w, "REPLACE")


def main():
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)
    bpy.ops.import_scene.gltf(filepath=args.glb)

    arm_obj = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    head = arm_obj.pose.bones.get("Head")
    if head is None:
        raise RuntimeError("no 'Head' bone - is this the expected rig?")
    head_z = (arm_obj.matrix_world @ head.head).z
    print(f"armature '{arm_obj.name}', Head z={head_z:.3f}")

    meshes = [o for o in bpy.data.objects
              if o.type == "MESH" and o.find_armature() is arm_obj]
    hair = max(meshes, key=lambda o: len(o.data.vertices))
    hair = next((o for o in meshes if any(
        ms.material and "pelo" in ms.material.name.lower()
        for ms in o.material_slots)), hair)
    print(f"hair mesh: '{hair.name}' ({len(hair.data.vertices)} verts)")

    axes = find_braid_axis(hair, head_z)
    if not axes:
        raise RuntimeError("no braids found")

    for label, axis in axes.items():
        captured = collect_braid_verts(axis, meshes)
        total = sum(len(h) for h in captured.values())
        tip_z = min((w.z for hits in captured.values() for _, w in hits),
                    default=axis["bottom"])
        print(f"\n[{label}] axis=({axis['x']:+.3f},{axis['y']:+.3f}) "
              f"z {axis['top']:.3f} -> {tip_z:.3f} "
              f"({(axis['top'] - tip_z) * 100:.1f} cm), {total} verts")
        for name, hits in captured.items():
            print(f"     {name}: {len(hits)}")
        if args.dry_run:
            continue
        bones = build_chain(arm_obj, label, axis, tip_z)
        for name, hits in captured.items():
            weight_braid(bpy.data.objects[name], hits, bones, axis, tip_z)
        print(f"     bones: {bones}")

    if args.dry_run:
        print("\ndry run - nothing written")
        return

    out = args.out
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_try_sparse_sk=True,
        export_skins=True,
        export_yup=True,
        export_animations=False,
        export_apply=False,
    )
    print(f"exported {out} ({Path(out).stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
