"""Delete coplanar duplicate surfaces - the cause of shimmering clothing.

The designer's dress ships as two meshes: `Plane.014`, the whole garment, and
`Plane.012`, a copy of just the torso with different UVs, laid on top as a
pattern overlay. Every one of its vertices sits at *exactly* the same position
as the base, both are opaque and double-sided, so the depth test picks a
different surface per pixel per frame and the torso shimmers. There is no
polygon offset and no transparency to make the layering work; the second layer
is simply lost.

This finds any mesh whose vertices coincide with another mesh's and removes the
smaller one, keeping whichever covers more of the garment.

  blender -b -noaudio -P remove_zfight_layer.py -- --glb <in.glb> --out <out.glb>
  blender -b -noaudio -P remove_zfight_layer.py -- --glb <in.glb> --dry-run
"""
import argparse
import sys
from pathlib import Path

import bpy
from mathutils import kdtree

# How close two vertices must be to count as the same surface.
COINCIDENT_M = 0.0005
# Fraction of the smaller mesh that must coincide before it is called a duplicate.
COINCIDENT_FRACTION = 0.9


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--out")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--keep", default="",
                   help="comma-separated mesh names never to delete")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def materials_of(obj):
    return {ms.material.name for ms in obj.material_slots if ms.material}


def coincident_fraction(small, big):
    """Share of `small`'s vertices that land on a vertex of `big`."""
    bw = big.matrix_world
    kd = kdtree.KDTree(len(big.data.vertices))
    for i, v in enumerate(big.data.vertices):
        kd.insert(bw @ v.co, i)
    kd.balance()
    sw = small.matrix_world
    hits = 0
    verts = small.data.vertices
    # Sampling is enough to classify, and the garment meshes run to thousands
    # of vertices.
    # bpy_prop_collection does not support extended slicing, hence range().
    step = max(1, len(verts) // 600)
    n = 0
    for i in range(0, len(verts), step):
        n += 1
        _, _, d = kd.find(sw @ verts[i].co)
        if d <= COINCIDENT_M:
            hits += 1
    return hits / max(n, 1)


def main():
    args = parse_args()
    keep = {s.strip() for s in args.keep.split(",") if s.strip()}
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)
    bpy.ops.import_scene.gltf(filepath=args.glb)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    doomed = []
    for i, a in enumerate(meshes):
        for bmesh in meshes[i + 1:]:
            shared = materials_of(a) & materials_of(bmesh)
            if not shared:
                continue
            small, big = sorted((a, bmesh), key=lambda o: len(o.data.vertices))
            frac = coincident_fraction(small, big)
            print(f"'{small.name}' ({len(small.data.vertices)}v) vs "
                  f"'{big.name}' ({len(big.data.vertices)}v) "
                  f"share {sorted(shared)}: {frac * 100:.0f}% coincident")
            if frac >= COINCIDENT_FRACTION:
                if small.name in keep:
                    print(f"   -> duplicate, but '{small.name}' is in --keep")
                elif small not in doomed:
                    doomed.append(small)
                    print(f"   -> DUPLICATE LAYER, removing '{small.name}'")

    if not doomed:
        print("\nno coplanar duplicates found")
    if args.dry_run:
        print("dry run - nothing written")
        return

    for o in doomed:
        print(f"removing '{o.name}' ({len(o.data.vertices)} verts)")
        bpy.data.objects.remove(o, do_unlink=True)

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
