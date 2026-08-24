"""Where exactly are the beads at the braid tips? Needed so they swing with it.

blender -b -noaudio -P probe_beads.py -- --glb <file.glb>
"""
import argparse
import sys

import bpy
from mathutils import Vector

AXES = {"L": (-0.152, -0.042), "R": (0.149, -0.042)}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def main():
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)
    bpy.ops.import_scene.gltf(filepath=args.glb)

    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        mw = obj.matrix_world
        for label, (ax, ay) in AXES.items():
            hits = []
            for i, v in enumerate(obj.data.vertices):
                w = mw @ v.co
                if not (1.36 <= w.z <= 1.46):
                    continue
                d = Vector((w.x - ax, w.y - ay, 0)).length
                if d <= 0.09:
                    hits.append((d, w))
            if not hits:
                continue
            hits.sort(key=lambda h: h[0])
            print(f"\n'{obj.name}' [{label}] {len(hits)} verts within 9 cm of the "
                  f"braid axis, z 1.36-1.46")
            for band in ((0, 0.02), (0.02, 0.035), (0.035, 0.05), (0.05, 0.09)):
                sel = [h for h in hits if band[0] <= h[0] < band[1]]
                if not sel:
                    continue
                zs = [h[1].z for h in sel]
                print(f"    d {band[0]:.3f}-{band[1]:.3f}: n={len(sel):>5} "
                      f"z[{min(zs):.3f},{max(zs):.3f}] "
                      f"y[{min(h[1].y for h in sel):+.3f},"
                      f"{max(h[1].y for h in sel):+.3f}]")


if __name__ == "__main__":
    main()
