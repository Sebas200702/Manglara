"""Render the exported avatar GLB from the same camera TalkingHead uses.

Headless: blender -b -noaudio -P render_check.py -- --glb <path> --outdir <dir>

Produces:
  head_view.png   - TalkingHead default 'head' view (cam z=2, fov 10deg)
  app_view.png    - tuned app framing: setView('head', {cameraDistance, cameraY})
  front_full.png  - full body from the front
  side_full.png   - full body from the right side
  morph_*.png     - face closeups with key blend shapes at 1.0 (if present)
"""

import argparse
import math
import sys
from pathlib import Path

import bpy
import mathutils

# Face closeup morph checks: (render suffix, {shape key: value})
MORPH_TESTS = [
    ("neutral", {}),
    ("eyesClosed", {"eyesClosed": 1.0}),
    ("viseme_aa", {"viseme_aa": 1.0}),
    ("viseme_O", {"viseme_O": 1.0}),
    ("mouthSmile", {"mouthSmile": 1.0}),
    ("eyeBlinkLeft", {"eyeBlinkLeft": 1.0}),
]

# Must match avatar-controller.ts setView options: setView("upper", {...})
APP_CAMERA_VIEW = "upper"  # 'upper' base z = 4.5, y anchor = 2/3 avatarHeight
APP_CAMERA_DISTANCE = 1.5
APP_CAMERA_Y = 0.5
TH_FOV_DEG = 10.0


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


def render(cam, outpath, width, height):
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.film_transparent = False
    scene.render.filepath = str(outpath)
    bpy.ops.render.render(write_still=True)
    print(f"[render_check] wrote {outpath}", flush=True)


def eye_bone_height():
    """avatarHeight the way TalkingHead computes it: LeftEye world y + 0.2."""
    for obj in bpy.data.objects:
        if obj.type != "ARMATURE":
            continue
        bone = obj.pose.bones.get("LeftEye")
        if bone:
            head_world = obj.matrix_world @ bone.head
            return head_world.z + 0.2  # Blender Z == glTF Y
    return None


def find_morph_mesh():
    best = None
    for obj in bpy.data.objects:
        if obj.type == "MESH" and obj.data.shape_keys:
            if best is None or len(obj.data.polygons) > len(best.data.polygons):
                best = obj
    return best


def main():
    args = parse_args()
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(Path(args.glb).resolve()))

    # Blender is Z-up: glTF (x, y, z) -> Blender (x, -z, y).
    # TalkingHead 'head' view default: cam (0, y, 2), target (0, y, 0) with
    # y = (1 - cameraY) * tan(fov/2) * z + 0.8 * avatarHeight.
    avatar_height = eye_bone_height() or 1.77
    tan_half = math.tan(math.radians(TH_FOV_DEG) / 2)
    print(f"[render_check] avatarHeight = {avatar_height:.4f}", flush=True)

    def head_view_y(camera_y, z):
        return (1 - camera_y) * tan_half * z + 0.8 * avatar_height

    # Default head view (cameraY default is 0.3 in TalkingHead)
    z = 2.0
    y = head_view_y(0.3, z)
    cam_head = add_camera("cam_head", (0, -z, y), (0, 0, y), TH_FOV_DEG)
    render(cam_head, outdir / "head_view.png", 1200, 500)

    # Tuned app view: TalkingHead 'upper' => z = 4.5 + dist,
    # y = (1 - cameraY) * tan(fov/2) * z + (2/3) * avatarHeight
    z = 4.5 + APP_CAMERA_DISTANCE
    y = (1 - APP_CAMERA_Y) * tan_half * z + 2 * avatar_height / 3
    print(f"[render_check] app view: cam z={z:.2f} y={y:.4f}", flush=True)
    cam_app = add_camera("cam_app", (0, -z, y), (0, 0, y), TH_FOV_DEG)
    render(cam_app, outdir / "app_view.png", 1200, 500)

    # Full body front + side
    cam_front = add_camera("cam_front", (0, -3.8, 0.9), (0, 0, 0.9), 30)
    render(cam_front, outdir / "front_full.png", 700, 900)
    cam_side = add_camera("cam_side", (3.8, 0, 0.9), (0, 0, 0.9), 30)
    render(cam_side, outdir / "side_full.png", 700, 900)

    # Morph checks: face closeup
    mesh = find_morph_mesh()
    if mesh is None:
        print("[render_check] no shape-keyed mesh found; skipping morph renders", flush=True)
        return
    keys = mesh.data.shape_keys.key_blocks
    face_y = avatar_height - 0.2  # eye height
    cam_face = add_camera("cam_face", (0, -1.6, face_y), (0, 0, face_y), 30)
    for suffix, morphs in MORPH_TESTS:
        for kb in keys:
            kb.value = 0.0
        missing = [m for m in morphs if m not in keys]
        if missing:
            print(f"[render_check] SKIP morph_{suffix}: missing {missing}", flush=True)
            continue
        for name, value in morphs.items():
            keys[name].value = value
        bpy.context.view_layer.update()
        render(cam_face, outdir / f"morph_{suffix}.png", 700, 700)
    for kb in keys:
        kb.value = 0.0


main()
