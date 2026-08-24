"""Unbind the skirt from the thigh bones so the legs move inside it.

The delivered rig binds 43% of the skirt to `LeftUpLeg`/`RightUpLeg` - automatic
weights treating the hem as if it were skin. A flared skirt is not skin: it hangs
off the hips as a shell and the legs swing *inside* it. Bound to the thighs, every
stance TalkingHead applies drags the fabric with the leg, which collapses the bell
and spikes the hem. Measure it with diag_skirt_weights.py before and after.

Leg weight is moved onto `Hips`, which the skirt is already mostly bound to;
`Spine` weight near the waist is left alone so the skirt still follows the torso.

  blender -b -noaudio -P fix_skirt_weights.py -- --glb <in.glb> --out <out.glb>
  blender -b -noaudio -P fix_skirt_weights.py -- --glb <in.glb> --dry-run
"""
import argparse
import sys
from pathlib import Path

import bpy

LEG_TOKENS = ("UpLeg", "Leg", "Foot", "Toe")
# Hips is a source, not the anchor. This rig's Hips bone has a -93 degree X
# rest rotation, but TalkingHead's pose templates assign it a near-identity
# rotation outright, so everything bound to Hips is thrown 90 degrees - the
# skirt flips out backwards like a bustle. The Spine chain's rest orientation
# does match the templates (the bodice, which hangs off it, poses correctly), so
# the garment is anchored there instead.
SOURCE_TOKENS = LEG_TOKENS + ("Hips",)
ANCHOR = "Spine"
# Materials of garments that hang rather than wrap. The sash tail hangs over the
# skirt and picks up the same bad weights.
GARMENT_MATERIALS = ("camisa", "cinta")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--out")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def is_garment(obj):
    return any(
        ms.material and any(g in ms.material.name.lower() for g in GARMENT_MATERIALS)
        for ms in obj.material_slots
    )


def main():
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)
    bpy.ops.import_scene.gltf(filepath=args.glb)

    total_moved = 0.0
    for obj in bpy.data.objects:
        if obj.type != "MESH" or not is_garment(obj):
            continue
        names = {vg.index: vg.name for vg in obj.vertex_groups}
        leg_idx = {i for i, n in names.items()
                   if any(t in n for t in SOURCE_TOKENS)}
        if not leg_idx:
            print(f"'{obj.name}': no leg groups, nothing to do")
            continue
        anchor = obj.vertex_groups.get(ANCHOR) or obj.vertex_groups.new(name=ANCHOR)

        moved = 0.0
        touched = 0
        for v in obj.data.vertices:
            leg_w = sum(g.weight for g in v.groups if g.group in leg_idx)
            if leg_w <= 1e-6:
                continue
            touched += 1
            moved += leg_w
            keep = {names[g.group]: g.weight for g in v.groups
                    if g.group not in leg_idx}
            keep[ANCHOR] = keep.get(ANCHOR, 0.0) + leg_w
            for vg in obj.vertex_groups:
                try:
                    vg.remove([v.index])
                except RuntimeError:
                    pass
            s = sum(keep.values()) or 1.0
            for nm, w in keep.items():
                if w <= 1e-6:
                    continue
                grp = obj.vertex_groups.get(nm) or obj.vertex_groups.new(name=nm)
                grp.add([v.index], w / s, "REPLACE")
        total_moved += moved
        print(f"'{obj.name}': moved {moved:.1f} weight off "
              f"{sorted(names[i] for i in leg_idx)} on {touched} verts -> {ANCHOR}")

    if args.dry_run:
        print(f"\ndry run - {total_moved:.1f} total weight would move")
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
