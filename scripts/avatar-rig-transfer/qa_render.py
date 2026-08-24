"""QA renders for the prepared avatar: framing, eyes, and blend-shape checks.

blender -b -noaudio -P qa_render.py -- --glb <path> --outdir <dir>
        [--hide "cabello 2"] [--morphs jawOpen,viseme_O] [--prefix v1_]

Reproduces TalkingHead's own camera maths so the framing seen here is the
framing the app will show (three.js FOV is VERTICAL, hence sensor_fit).
"""
import argparse
import math
import sys
from pathlib import Path

import bpy
import mathutils

TH_FOV_DEG = 10.0
APP_CAMERA_DISTANCE = 1.5     # avatar-controller.ts setView("upper", {...})
APP_CAMERA_Y = 0.5

DEFAULT_MORPHS = ["jawOpen", "viseme_aa", "viseme_O", "viseme_PP", "viseme_U",
                  "mouthSmile", "eyesClosed", "eyeBlinkLeft", "browInnerUp"]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--outdir", required=True)
    p.add_argument("--hide", default="")
    p.add_argument("--morphs", default=",".join(DEFAULT_MORPHS))
    p.add_argument("--prefix", default="")
    p.add_argument("--no-body", action="store_true")
    # Workbench picks the FIRST image-texture node of a material, which on this
    # asset is the metallic/roughness map - it renders the irises pure white and
    # ignores vertex colours. EEVEE evaluates the real shader graph.
    p.add_argument("--engine", default="EEVEE", choices=["EEVEE", "WORKBENCH"])
    return p.parse_args(sys.argv[sys.argv.index("--") + 1:])


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)


def add_cam(name, loc, look, fov):
    cd = bpy.data.cameras.new(name)
    cd.lens_unit = "FOV"
    cd.sensor_fit = "VERTICAL"
    cd.angle = math.radians(fov)
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = loc
    cam.rotation_euler = (mathutils.Vector(look) - mathutils.Vector(loc)) \
        .to_track_quat("-Z", "Y").to_euler()
    return cam


ENGINE = "EEVEE"


def setup_lighting():
    """Neutral three-point rig so EEVEE renders read like the app's canvas."""
    world = bpy.data.worlds.new("qa")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.28, 0.28, 0.30, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.1
    bpy.context.scene.world = world
    for name, loc, energy in [("key", (1.2, -2.0, 2.4), 320),
                              ("fill", (-1.8, -1.6, 1.4), 120),
                              ("rim", (0.0, 2.2, 2.2), 180)]:
        d = bpy.data.lights.new(name, type="AREA")
        d.energy = energy
        d.size = 2.0
        o = bpy.data.objects.new(name, d)
        o.location = loc
        o.rotation_euler = (mathutils.Vector((0, 0, 1.5)) - mathutils.Vector(loc)) \
            .to_track_quat("-Z", "Y").to_euler()
        bpy.context.scene.collection.objects.link(o)


def render(cam, path, w, h):
    s = bpy.context.scene
    s.camera = cam
    if ENGINE == "EEVEE":
        s.render.engine = "BLENDER_EEVEE"
        s.eevee.taa_render_samples = 24
        # Without occlusion the mouth cavity is lit exactly like the skin and an
        # open mouth reads as a flat flesh-coloured panel.
        for attr, value in (("use_raytracing", True), ("use_shadows", True),
                            ("use_gtao", True)):
            if hasattr(s.eevee, attr):
                setattr(s.eevee, attr, value)
    else:
        s.render.engine = "BLENDER_WORKBENCH"
        s.display.shading.light = "STUDIO"
        s.display.shading.color_type = "TEXTURE"
    s.render.resolution_x, s.render.resolution_y = w, h
    s.render.film_transparent = False
    s.render.filepath = str(Path(path).resolve())
    bpy.ops.render.render(write_still=True)
    print(f"[qa] {path}", flush=True)


def main():
    a = parse_args()
    out = Path(a.outdir)
    out.mkdir(parents=True, exist_ok=True)
    pre = a.prefix
    global ENGINE
    ENGINE = a.engine
    clear()
    bpy.ops.import_scene.gltf(filepath=str(Path(a.glb).resolve()), bone_heuristic="BLENDER")
    if ENGINE == "EEVEE":
        setup_lighting()

    for name in [n.strip() for n in a.hide.split(",") if n.strip()]:
        o = bpy.data.objects.get(name)
        if o:
            o.hide_render = True
            print(f"[qa] hidden: {name}", flush=True)

    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    eye = arm.data.bones.get("LeftEye")
    if eye is None:
        raise RuntimeError("LeftEye bone missing - TalkingHead would throw here")
    eye_z = (arm.matrix_world @ eye.head_local).z
    avatar_height = eye_z + 0.2            # TalkingHead's own estimate
    tan_half = math.tan(math.radians(TH_FOV_DEG) / 2)
    print(f"[qa] LeftEye y={eye_z:.4f}  avatarHeight={avatar_height:.4f}", flush=True)

    if not a.no_body:
        # TalkingHead 'head' view: cam z=2, y = (1-cameraY)*tan(fov/2)*z + 0.8*h
        z = 2.0
        y = (1 - 0.3) * tan_half * z + 0.8 * avatar_height
        render(add_cam("head", (0, -z, y), (0, 0, y), TH_FOV_DEG),
               out / f"{pre}view_head.png", 1200, 500)

        # App view: 'upper' base z = 4.5 + distance, y anchor = 2/3 * height
        z = 4.5 + APP_CAMERA_DISTANCE
        y = (1 - APP_CAMERA_Y) * tan_half * z + 2 * avatar_height / 3
        render(add_cam("app", (0, -z, y), (0, 0, y), TH_FOV_DEG),
               out / f"{pre}view_app.png", 1200, 700)

        render(add_cam("front", (0, -3.6, 0.95), (0, 0, 0.95), 32),
               out / f"{pre}front.png", 700, 950)

    # Face close-ups
    fz = eye_z - 0.03
    render(add_cam("face", (0, -0.62, fz), (0, -0.05, fz), 34), out / f"{pre}face.png", 850, 850)
    render(add_cam("f34", (0.34, -0.52, fz), (0, -0.05, fz), 34), out / f"{pre}face34.png", 850, 850)

    # Blend shapes
    morph_objs = [o for o in bpy.data.objects
                  if o.type == "MESH" and o.data.shape_keys and not o.hide_render]
    if not morph_objs:
        print("[qa] no blend shapes present; skipping morph renders", flush=True)
        return
    present = set()
    for o in morph_objs:
        present.update(kb.name for kb in o.data.shape_keys.key_blocks)
    print(f"[qa] {len(present)-1} blend shapes across {len(morph_objs)} meshes", flush=True)

    mz = eye_z - 0.09
    cam_m = add_cam("mouth", (0, -0.40, mz), (0, -0.05, mz), 32)
    # Eye/brow shapes need the upper face in frame, mouth shapes need the crop.
    cam_e = add_cam("upper", (0, -0.55, eye_z + 0.01), (0, -0.05, eye_z + 0.01), 32)
    # Profile: a jaw drop is unmistakable from the side and easy to miss head-on.
    cam_p = add_cam("profile", (0.42, -0.12, mz), (0, -0.06, mz), 32)

    def cam_for(morph):
        upper = ("eye", "brow", "cheekSquint", "nose")
        return cam_e if any(morph.startswith(p) for p in upper) else cam_m

    for name in [m.strip() for m in a.morphs.split(",") if m.strip()]:
        hit = False
        for o in morph_objs:
            kbs = o.data.shape_keys.key_blocks
            for kb in kbs:
                kb.value = 0.0
            if name in kbs:
                kbs[name].value = 1.0
                hit = True
        if not hit:
            print(f"[qa] SKIP {name}: not present", flush=True)
            continue
        bpy.context.view_layer.update()
        render(cam_for(name), out / f"{pre}morph_{name}.png", 700, 700)
        if cam_for(name) is cam_m:
            render(cam_p, out / f"{pre}morph_{name}_side.png", 700, 700)
    for o in morph_objs:
        for kb in o.data.shape_keys.key_blocks:
            kb.value = 0.0


main()
