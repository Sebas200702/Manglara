"""Tight mouth-closeup renders to judge the crease approach at live-like values.

Headless: blender -b -noaudio -P render_mouth.py -- --glb <path> --outdir <dir>
"""

import argparse
import math
import sys
from pathlib import Path

import bpy
import mathutils

# (suffix, {shape key: value}) — live HeadAudio values are partial (~0.3-0.7),
# so include half-strength probes alongside the full-strength ones.
TESTS = [
    ("neutral", {}),
    ("aa_100", {"viseme_aa": 1.0}),
    ("aa_050", {"viseme_aa": 0.5}),
    ("O_100", {"viseme_O": 1.0}),
    ("O_050", {"viseme_O": 0.5}),
    ("E_100", {"viseme_E": 1.0}),
    ("jawOpen_100", {"jawOpen": 1.0}),
    ("PP_100", {"viseme_PP": 1.0}),
]

MOUTH_Z = 1.475  # painted mouth height in FINAL avatar space (post scale-mult)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", required=True)
    parser.add_argument("--outdir", required=True)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:])


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)


def add_camera(name, location, look_at, fov_deg):
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(fov_deg)
    cam = bpy.data.objects.new(name, cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = location
    direction = mathutils.Vector(look_at) - mathutils.Vector(location)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return cam


def render(cam, outpath, engine="BLENDER_WORKBENCH"):
    scene = bpy.context.scene
    scene.camera = cam
    if engine == "BLENDER_WORKBENCH":
        scene.render.engine = engine
    else:
        for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
            try:
                scene.render.engine = eng
                break
            except TypeError:
                continue
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    scene.render.film_transparent = False
    scene.render.filepath = str(outpath)
    bpy.ops.render.render(write_still=True)
    print(f"[render_mouth] wrote {outpath}", flush=True)


def find_morph_meshes():
    return [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]


def bake_test_sprite():
    """Paint an 'aa' mouth (dark cavity + teeth) into the MouthOverlay texture,
    simulating what avatar-controller.ts draws at runtime. Returns the overlay
    object, or None when the GLB has no overlay."""
    import numpy as np

    ov = bpy.data.objects.get("MouthOverlay")
    if ov is None:
        print("[render_mouth] no MouthOverlay in GLB; skipping sprite bake", flush=True)
        return None

    H, W = 256, 512
    yy, xx = np.mgrid[0:H, 0:W]
    v = yy / (H - 1)  # 0 at the BOTTOM row (Blender image space)
    u = xx / (W - 1)
    line_v, open_, hw, cx = 0.625, 1.0, 0.40, 0.5

    img = np.zeros((H, W, 4))
    top = line_v + 0.10 * open_
    bot = line_v - 0.46 * open_
    mid, rv = (top + bot) / 2, (top - bot) / 2
    d = ((u - cx) / hw) ** 2 + ((v - mid) / rv) ** 2
    cav = d < 1.0
    img[cav] = (0.18, 0.06, 0.04, 1.0)
    teeth = cav & (v > line_v - 0.14) & (np.abs(u - cx) < hw * 0.7)
    img[teeth] = (0.93, 0.90, 0.85, 1.0)
    outline = (~cav) & (d < 1.18)
    img[outline] = (0.25, 0.09, 0.05, 0.9)

    tex_img = bpy.data.images.new("MouthTestSprite", W, H, alpha=True)
    tex_img.pixels = img.reshape(-1).tolist()
    for mat_slot in ov.material_slots:
        mat = mat_slot.material
        if mat and mat.use_nodes:
            for node in mat.node_tree.nodes:
                if node.type == "TEX_IMAGE":
                    node.image = tex_img
        for attr, val in (("blend_method", "BLEND"),
                          ("surface_render_method", "BLENDED")):
            try:
                setattr(mat, attr, val)
            except (AttributeError, TypeError):
                pass
    print("[render_mouth] baked test sprite into MouthOverlay", flush=True)
    return ov


def main():
    args = parse_args()
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(Path(args.glb).resolve()))

    meshes = find_morph_meshes()
    if not meshes:
        print("[render_mouth] no shape-keyed mesh found", flush=True)
        return

    def set_morphs(morphs):
        for m in meshes:
            for kb in m.data.shape_keys.key_blocks:
                kb.value = morphs.get(kb.name, 0.0)
        bpy.context.view_layer.update()

    main_keys = max(meshes, key=lambda m: len(m.data.polygons)).data.shape_keys.key_blocks

    # Straight-on tight crop of the lower face, plus a 3/4 angle (creases read
    # mostly through shading, which the angled view exposes better).
    cam_front = add_camera("cam_front", (0, -0.55, MOUTH_Z + 0.02), (0, 0, MOUTH_Z + 0.02), 24)
    cam_angle = add_camera("cam_angle", (0.35, -0.45, MOUTH_Z + 0.04), (0, 0, MOUTH_Z), 24)

    for suffix, morphs in TESTS:
        missing = [m for m in morphs if m not in main_keys]
        if missing:
            print(f"[render_mouth] SKIP {suffix}: missing {missing}", flush=True)
            continue
        set_morphs(morphs)
        render(cam_front, outdir / f"mouth_{suffix}.png")
        render(cam_angle, outdir / f"mouth34_{suffix}.png")
    set_morphs({})

    # Sprite-mouth preview: bake the runtime canvas drawing into the overlay
    # texture and render with EEVEE (Workbench ignores alpha blending).
    if bake_test_sprite() is not None:
        world = bpy.data.worlds.new("PreviewWorld")
        world.use_nodes = True
        bg = world.node_tree.nodes["Background"]
        bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
        bg.inputs[1].default_value = 1.0
        bpy.context.scene.world = world

        set_morphs({"viseme_aa": 1.0})
        render(cam_front, outdir / "sprite_aa.png", engine="EEVEE")
        set_morphs({"viseme_O": 1.0})
        render(cam_front, outdir / "sprite_O.png", engine="EEVEE")
        set_morphs({})
        render(cam_front, outdir / "sprite_neutral.png", engine="EEVEE")


main()
