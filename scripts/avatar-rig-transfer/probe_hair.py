"""Locate the hanging braids in the avatar so bones can be fitted to them.

Prints, per skinned mesh, the vertices that sit below head height and away from
the body centre - the braid candidates - clustered left/right, sliced by height.
Run before add_hair_bones.py to sanity-check the region it will grab.

blender -b -noaudio -P probe_hair.py -- --glb <file.glb>
"""
import argparse
import sys

import bpy
from mathutils import Vector


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def main():
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)
    bpy.ops.import_scene.gltf(filepath=args.glb)

    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    head = arm.pose.bones.get("Head")
    head_w = (arm.matrix_world @ head.head) if head else Vector((0, 0, 1.5))
    print(f"armature '{arm.name}', Head at z={head_w.z:.3f}")

    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        co = [mw @ v.co for v in obj.data.vertices]
        if not co:
            continue
        zs = [c.z for c in co]
        xs = [c.x for c in co]
        ys = [c.y for c in co]
        mats = [ms.material.name if ms.material else None for ms in obj.material_slots]
        print(f"\n'{obj.name}' verts={len(co)} mats={mats}")
        print(f"   x[{min(xs):+.3f},{max(xs):+.3f}] "
              f"y[{min(ys):+.3f},{max(ys):+.3f}] z[{min(zs):+.3f},{max(zs):+.3f}]")

        # Braid candidates: below the head joint and off the midline.
        cand = [c for c in co if c.z < head_w.z and abs(c.x) > 0.055]
        if not cand:
            print("   no braid candidates")
            continue
        left = [c for c in cand if c.x < 0]
        right = [c for c in cand if c.x > 0]
        for label, side in (("L", left), ("R", right)):
            if not side:
                continue
            sz = [c.z for c in side]
            print(f"   {label}: {len(side)} verts, z[{min(sz):.3f},{max(sz):.3f}], "
                  f"x[{min(c.x for c in side):+.3f},{max(c.x for c in side):+.3f}]")
            lo, hi = min(sz), max(sz)
            if hi - lo < 1e-4:
                continue
            for k in range(6):
                z0 = lo + (hi - lo) * k / 6
                z1 = lo + (hi - lo) * (k + 1) / 6
                sl = [c for c in side if z0 <= c.z <= z1]
                if not sl:
                    continue
                cx = sum(c.x for c in sl) / len(sl)
                cy = sum(c.y for c in sl) / len(sl)
                rad = max((Vector((c.x - cx, c.y - cy, 0)).length for c in sl),
                          default=0)
                print(f"      z {z0:.3f}..{z1:.3f}: n={len(sl):>5} "
                      f"centre=({cx:+.3f},{cy:+.3f}) radius={rad:.3f}")


if __name__ == "__main__":
    main()
