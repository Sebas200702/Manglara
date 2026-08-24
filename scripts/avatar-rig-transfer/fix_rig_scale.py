"""Align the rig to the reference frame TalkingHead's pose templates assume.

Two mismatches, both purely about where the skeleton sits in space - the model
itself is fine, as the Blender rest render shows.

1. HIP HEIGHT. Every standing pose in `talkinghead.mjs` hardcodes
   `'Hips.position': {x:0, y:1, z:0}` - authored against a Ready Player Me
   reference skeleton whose hips sit one metre off the ground. This delivery's
   hips sit at 0.908 m, so the library lifts them 9 cm on every pose. Its
   per-frame "hip-feet balance" then pulls them back down until the lowest
   vertex touches the floor, which it achieves by stretching the legs.

2. FEET CENTRING. That same balance loop runs
   `objectHips.position.z -= (leftToe.z + rightToe.z) / 2` every frame, i.e. it
   slides the hips backwards until the toes sit over the origin. In the
   reference rig the toes are already there; in this one they stand 13 cm
   forward, so the loop rams the waist ~9 cm backwards and the torso leans back
   over the legs. That is the bent waist, and the skirt - which hangs off the
   hips - crumples with it.

Scaling about the floor plane and re-centring the feet on the origin removes
both. Bone rotations are scale- and translation-invariant, so no pose changes.

  blender -b -noaudio -P fix_rig_scale.py -- --glb <in.glb> --out <out.glb>
  blender -b -noaudio -P fix_rig_scale.py -- --glb <in.glb> --dry-run
"""
import argparse
import sys
from pathlib import Path

import bpy

# The hip height every standing pose template in talkinghead.mjs assumes.
TARGET_HIP_Y = 1.0


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--out")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def main():
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)
    bpy.ops.import_scene.gltf(filepath=args.glb)

    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    head_bone = arm.pose.bones.get("Hips")
    if head_bone is None:
        raise RuntimeError("no 'Hips' bone")
    # Blender is Z-up: glTF's Y is Blender's Z.
    hip_z = (arm.matrix_world @ head_bone.head).z

    # Skinned meshes only. Blender's glTF importer also materialises a unit
    # `Icosphere` for the scene's environment; at z=-1 it drags the measured
    # floor a whole metre below the feet and the scale comes out half-size.
    meshes = [o for o in bpy.data.objects
              if o.type == "MESH" and o.find_armature() is arm]
    if not meshes:
        raise RuntimeError("no meshes skinned to the armature")
    floor = min((o.matrix_world @ v.co).z
                for o in meshes for v in o.data.vertices)
    top = max((o.matrix_world @ v.co).z
              for o in meshes for v in o.data.vertices)

    factor = TARGET_HIP_Y / (hip_z - floor)

    # Feet centring. Blender is Z-up, so glTF's Z (the one the balance loop
    # corrects) is Blender's -Y.
    toes = [arm.pose.bones.get(n) for n in ("LeftToeBase", "RightToeBase")]
    if not all(toes):
        raise RuntimeError("no ToeBase bones - cannot centre the feet")
    tw = [arm.matrix_world @ t.head for t in toes]
    toe_x = sum(p.x for p in tw) / 2
    toe_y = sum(p.y for p in tw) / 2

    print(f"floor z={floor:.4f}  hips z={hip_z:.4f}  height={top - floor:.4f}")
    print(f"hip height {hip_z - floor:.4f} -> {TARGET_HIP_Y}: scale x{factor:.4f}")
    print(f"total height {top - floor:.3f} -> {(top - floor) * factor:.3f} m")
    print(f"toes at glTF (x={toe_x:+.4f}, z={-toe_y:+.4f}) -> centring on origin")

    # Offsets are applied after scaling, so scale them too.
    dx = -toe_x * factor
    dy = -toe_y * factor
    if abs(factor - 1.0) < 0.005 and abs(dx) < 0.002 and abs(dy) < 0.002:
        print("already aligned - nothing to do")
        return
    if args.dry_run:
        print("dry run - nothing written")
        return

    # Scale about the floor plane so the feet stay planted, then re-centre.
    def place(p):
        p.x = p.x * factor + dx
        p.y = p.y * factor + dy
        p.z = floor + (p.z - floor) * factor

    for o in meshes:
        for v in o.data.vertices:
            place(v.co)
        sk = o.data.shape_keys
        if sk:
            # Shape keys hold absolute positions, so they move too.
            for kb in sk.key_blocks:
                for d in kb.data:
                    place(d.co)
        print(f"  moved '{o.name}' ({len(o.data.vertices)} verts"
              f"{', ' + str(len(sk.key_blocks)) + ' shape keys' if sk else ''})")

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for b in arm.data.edit_bones:
        place(b.head)
        place(b.tail)
        b.length = max(b.length, 1e-5)
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"  moved {len(arm.data.bones)} bones")

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
