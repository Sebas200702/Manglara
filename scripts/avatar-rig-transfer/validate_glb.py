#!/usr/bin/env python3
"""Validate a TalkingHead-compatible GLB."""

import argparse
import sys
import bpy

REQUIRED_BONES = {
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot",
    "RightUpLeg", "RightLeg", "RightFoot",
}

REQUIRED_ARKIT = [
    "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight",
    "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawRight",
    "jawOpen", "mouthClose", "mouthFunnel", "mouthPucker", "mouthLeft",
    "mouthRight", "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft",
    "mouthFrownRight", "mouthDimpleLeft", "mouthDimpleRight", "mouthStretchLeft",
    "mouthStretchRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower",
    "mouthShrugUpper", "mouthPressLeft", "mouthPressRight", "mouthLowerDownLeft",
    "mouthLowerDownRight", "mouthUpperUpLeft", "mouthUpperUpRight", "browDownLeft",
    "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
    "cheekPuff", "cheekSquintLeft", "cheekSquintRight", "noseSneerLeft",
    "noseSneerRight", "tongueOut"
]

REQUIRED_VISEMES = [
    "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD",
    "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR",
    "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U"
]

REQUIRED_EXTRAS = ["mouthOpen", "mouthSmile", "eyesClosed", "eyesLookUp", "eyesLookDown"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--glb", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])

    # Clear scene and import
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)
    bpy.ops.import_scene.gltf(filepath=args.glb)

    armature = None
    meshes = []
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE":
            armature = obj
        elif obj.type == "MESH":
            meshes.append(obj)

    print("\n=== TALKINGHEAD GLB VALIDATION ===\n")

    # Armature / root
    if armature is None:
        print("FAIL: No armature found")
        sys.exit(1)
    print(f"Armature name: {armature.name}")
    if armature.name != "Armature":
        print(f"WARN: Armature name is '{armature.name}', expected 'Armature'")

    # Bones
    bones = {b.name for b in armature.data.bones}
    missing_bones = REQUIRED_BONES - bones
    print(f"Bones: {len(bones)} total, {len(REQUIRED_BONES - missing_bones)}/{len(REQUIRED_BONES)} required present")
    if missing_bones:
        print(f"MISSING BONES: {sorted(missing_bones)}")

    # Shape keys across all meshes
    all_shape_keys = set()
    for mesh in meshes:
        if mesh.data.shape_keys:
            for kb in mesh.data.shape_keys.key_blocks:
                all_shape_keys.add(kb.name)

    print(f"\nTotal shape keys across meshes: {len(all_shape_keys)}")

    def check_set(name, required):
        missing = [r for r in required if r not in all_shape_keys]
        present = len(required) - len(missing)
        print(f"{name}: {present}/{len(required)} present")
        if missing:
            print(f"  MISSING: {missing}")
        return len(missing) == 0

    ok_arkit = check_set("ARKit blend shapes", REQUIRED_ARKIT)
    ok_visemes = check_set("Oculus visemes", REQUIRED_VISEMES)
    ok_extras = check_set("Extras", REQUIRED_EXTRAS)

    print(f"\nMeshes: {len(meshes)}")
    for m in meshes:
        sk_count = len(m.data.shape_keys.key_blocks) if m.data.shape_keys else 0
        print(f"  - {m.name}: {len(m.data.polygons)} polygons, {sk_count} shape keys")

    print("\n=== VALIDATION COMPLETE ===")
    if missing_bones or not ok_arkit or not ok_visemes or not ok_extras:
        print("RESULT: FAIL")
        sys.exit(1)
    print("RESULT: PASS")


if __name__ == "__main__":
    main()
