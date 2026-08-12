#!/usr/bin/env python3
"""
TalkingHead rig/blendshape transfer pipeline.

Takes a TalkingHead-compatible reference GLB (e.g. brunette.glb) and a target
humanoid mesh (static GLB), then produces a TalkingHead-compatible GLB with:
  - Mixamo-compatible armature copied from the reference
  - Vertex group / skin weights transferred from the reference
  - 52 ARKit + 15 Oculus + 5 extra blend shapes transferred to the target mesh
  - Correct bone rolls and character scale

Intended to run headless:
    blender -b -P transfer_rig.py -- --ref refs/brunette.glb --target "C:\\...\\3d character model.glb" --output output/custom_avatar.glb
"""

import argparse
import math
import os
import sys
import time
import traceback
from pathlib import Path

import bpy
import mathutils

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

def log(msg):
    print(f"[transfer_rig] {msg}", flush=True)


def log_stage(stage):
    log("=" * 60)
    log(f"STAGE: {stage}")
    log("=" * 60)


# ---------------------------------------------------------------------------
# Blender / scene utilities
# ---------------------------------------------------------------------------

def clear_scene():
    """Remove every object, mesh, armature and material from the current scene."""
    log("Clearing default scene...")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False, confirm=False)

    for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials,
                  bpy.data.textures, bpy.data.images, bpy.data.actions,
                  bpy.data.shape_keys):
        for item in list(block):
            try:
                block.remove(item)
            except Exception:
                pass

    log("Scene cleared.")


def import_glb(path):
    """Import a GLB/GLTF file and return the collection of newly created objects."""
    path = str(Path(path).resolve())
    log(f"Importing GLB: {path}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    after = set(bpy.data.objects)
    new_objs = list(after - before)
    log(f"  -> {len(new_objs)} objects imported")
    return new_objs


def find_armature(objects):
    """Return the first armature object."""
    for obj in objects:
        if obj.type == "ARMATURE":
            return obj
    # Fallback: search whole scene
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE":
            return obj
    raise RuntimeError("No armature found in imported objects")


def find_meshes(objects=None):
    """Return all mesh objects (optionally restricted to the provided list)."""
    if objects is None:
        objects = bpy.data.objects
    return [o for o in objects if o.type == "MESH"]


def find_main_mesh(meshes):
    """Pick the largest mesh by polygon count as the main body/face mesh."""
    if not meshes:
        raise RuntimeError("No mesh objects found")
    meshes = sorted(meshes, key=lambda m: len(m.data.polygons), reverse=True)
    log(f"Main mesh selected: {meshes[0].name} ({len(meshes[0].data.polygons)} polygons)")
    return meshes[0]


def apply_all_transforms(obj):
    """Apply location/rotation/scale transforms."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def set_active(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)


# ---------------------------------------------------------------------------
# TalkingHead add-on utilities
# ---------------------------------------------------------------------------

def load_talkinghead_addon(addon_path):
    """Import the talkinghead addon module so we can call its helper functions."""
    addon_path = str(Path(addon_path).resolve())
    if not os.path.exists(addon_path):
        raise RuntimeError(f"TalkingHead add-on not found at {addon_path}")

    import importlib.util
    spec = importlib.util.spec_from_file_location("talkinghead_addon", addon_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["talkinghead_addon"] = module
    spec.loader.exec_module(module)
    log("TalkingHead add-on helpers loaded.")
    return module


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

def bounding_box_info(obj):
    """Return (min, max, center, height) of an object's bounding box in world space."""
    matrix = obj.matrix_world
    corners = [matrix @ mathutils.Vector(c) for c in obj.bound_box]
    min_v = mathutils.Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    max_v = mathutils.Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    center = (min_v + max_v) / 2
    height = max_v.z - min_v.z
    return min_v, max_v, center, height


def log_mesh_bbox(tag, meshes):
    """Log world-space bbox of the main target mesh; diagnoses offset bugs."""
    try:
        main = find_main_mesh(find_meshes(meshes))
        bpy.context.view_layer.update()
        min_v, max_v, center, height = bounding_box_info(main)
        log(f"  [bbox:{tag}] center=({center.x:.4f}, {center.y:.4f}, {center.z:.4f}) "
            f"min=({min_v.x:.4f}, {min_v.y:.4f}, {min_v.z:.4f}) "
            f"max=({max_v.x:.4f}, {max_v.y:.4f}, {max_v.z:.4f}) height={height:.4f}")
    except Exception as e:
        log(f"  [bbox:{tag}] unavailable: {e}")


def rotate_target_yaw(target_objs, yaw_deg):
    """
    Rotate the target meshes around the vertical (Z) axis so the character
    faces Blender -Y (= glTF +Z, toward the TalkingHead camera), matching the
    reference. Weight and blendshape transfers are proximity-based, so the
    orientation must match BEFORE any transfer runs.
    """
    if abs(yaw_deg) < 1e-6:
        return
    log(f"Rotating target {yaw_deg:.1f} deg around Z...")
    rot = mathutils.Matrix.Rotation(math.radians(yaw_deg), 4, "Z")
    for obj in target_objs:
        if obj.type != "MESH":
            continue
        apply_all_transforms(obj)
        obj.matrix_world = rot @ obj.matrix_world
        apply_all_transforms(obj)
    log_mesh_bbox("post-yaw", target_objs)


def align_target_to_reference(target_objs, ref_armature, scale_mult=1.0):
    """
    Translate and scale target objects so their bounding box matches the
    reference armature's bounding box height and vertical placement.

    scale_mult stretches the target beyond the height match. For stylized
    characters (oversized head) matching total heights leaves the face far
    below the reference face, so the proximity-based weight/blendshape
    transfers sample the wrong regions. Use scale_mult = ref_eye_height /
    target_eye_height_after_height_match to align the faces instead; the
    extra height ends up above the reference head (hair), where nothing is
    sampled.
    """
    log("Aligning target to reference...")
    ref_min, ref_max, ref_center, ref_height = bounding_box_info(ref_armature)

    target_meshes = find_meshes(target_objs)
    main_mesh = find_main_mesh(target_meshes)
    target_min, target_max, target_center, target_height = bounding_box_info(main_mesh)

    log(f"  Reference height: {ref_height:.4f}  |  Target height: {target_height:.4f}")
    if target_height < 1e-6:
        raise RuntimeError("Target mesh has zero height")

    # Scale factor to match heights, then face-alignment multiplier
    scale_factor = (ref_height / target_height) * scale_mult
    log(f"  Scale factor: {scale_factor:.4f} (height match x {scale_mult})")

    # Scale about world origin first, then translate: center horizontally at
    # origin and rest the bottom on the reference bottom. Translation must be
    # computed from the post-scale bbox, otherwise a residual offset of
    # center*(scale-1) remains.
    for obj in target_objs:
        if obj.type != "MESH":
            continue
        apply_all_transforms(obj)
        obj.scale *= scale_factor
        apply_all_transforms(obj)

    bpy.context.view_layer.update()
    target_min, target_max, target_center, _ = bounding_box_info(main_mesh)
    shift = mathutils.Vector((-target_center.x, -target_center.y,
                              ref_min.z - target_min.z))
    log(f"  Post-scale shift: ({shift.x:.4f}, {shift.y:.4f}, {shift.z:.4f})")

    for obj in target_objs:
        if obj.type != "MESH":
            continue
        obj.location += shift
        apply_all_transforms(obj)

    log_mesh_bbox("post-align", target_objs)
    log("Target aligned.")


def recenter_mesh_horizontally(target_objs):
    """
    Safety net before export: the armature (and its Hips bone) sits on the
    world Z axis, so the mesh bbox must be centered at x=0 in world space or
    TalkingHead's camera/head tracking points at empty space. Shifts mesh
    object data only in X (Blender front/back Y is left as authored).
    """
    meshes = find_meshes(target_objs)
    main = find_main_mesh(meshes)
    bpy.context.view_layer.update()
    _, _, center, _ = bounding_box_info(main)
    if abs(center.x) < 0.005:
        log(f"Recenter check OK (bbox center x = {center.x:.4f})")
        return
    log(f"WARNING: mesh bbox center x = {center.x:.4f}; recentering to 0")
    for obj in meshes:
        obj.location.x -= center.x
        apply_all_transforms(obj)
    log_mesh_bbox("post-recenter", target_objs)


# ---------------------------------------------------------------------------
# Armature transfer
# ---------------------------------------------------------------------------

def transfer_armature(ref_armature, target_objs):
    """Duplicate the reference armature and reparent it under the target root."""
    log("Transferring armature...")

    # Make sure reference armature transforms are applied
    apply_all_transforms(ref_armature)

    # Duplicate armature
    set_active(ref_armature)
    bpy.ops.object.duplicate()
    target_armature = bpy.context.active_object
    target_armature.name = "Armature"
    target_armature.data.name = "ArmatureData"

    # Unlink from any reference collections if needed
    # (scene.collections[0] is fine for our headless export)
    log(f"  New armature: {target_armature.name}")
    return target_armature


def strip_mixamorig_prefix(armature):
    """Remove 'mixamorig:' prefix from bone names (TalkingHead expects clean names)."""
    log("Checking Mixamo prefix...")
    changed = 0
    for bone in armature.data.bones:
        if bone.name.startswith("mixamorig:"):
            bone.name = bone.name.replace("mixamorig:", "")
            changed += 1
    log(f"  Renamed {changed} bones")


def remove_prefix_from_vertex_groups(mesh_obj, prefix="mixamorig:"):
    """Remove the same prefix from vertex groups so weights still bind to bones."""
    if not mesh_obj.vertex_groups:
        return
    for vg in list(mesh_obj.vertex_groups):
        if vg.name.startswith(prefix):
            vg.name = vg.name.replace(prefix, "")


# ---------------------------------------------------------------------------
# Weight transfer
# ---------------------------------------------------------------------------

def parent_mesh_to_armature(mesh_obj, armature):
    """Parent mesh to armature with empty vertex groups."""
    bpy.ops.object.select_all(action="DESELECT")
    mesh_obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_NAME")


def transfer_weights_data_transfer(target_obj, source_obj, armature):
    """Transfer vertex group weights from source mesh to target mesh via Data Transfer."""
    log(f"Transferring weights to {target_obj.name}...")

    set_active(target_obj)

    # Parent target to armature with empty groups (creates vertex groups)
    parent_mesh_to_armature(target_obj, armature)
    log("  Parented target to armature with empty groups")

    # Add Data Transfer modifier
    set_active(target_obj)
    dt = target_obj.modifiers.new(name="TH_WeightTransfer", type="DATA_TRANSFER")
    dt.object = source_obj
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "NEAREST"
    dt.mix_mode = "REPLACE"
    dt.mix_factor = 1.0

    log("  Applying Data Transfer modifier for weights...")
    bpy.ops.object.datalayout_transfer(modifier=dt.name)
    bpy.ops.object.modifier_apply(modifier=dt.name)

    remove_prefix_from_vertex_groups(target_obj)

    # Limit to 4 bone influences per vertex to reduce boil / ballooning
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_clean(
        group_select_mode="ALL", limit=0.005, keep_single=False
    )
    log("  Weight transfer complete")


def add_armature_modifier(target_obj, armature):
    """Ensure target has an Armature modifier pointing to the armature."""
    has_arm = any(mod.type == "ARMATURE" for mod in target_obj.modifiers)
    if not has_arm:
        mod = target_obj.modifiers.new(name="Armature", type="ARMATURE")
        mod.object = armature
        mod.use_vertex_groups = True
        mod.use_deform_preserve_volume = False


def decimate_mesh(mesh_obj, ratio):
    """
    Reduce polygon count with a Decimate modifier. This is required when the
    source mesh is very dense (e.g. AI-generated photogrammetry) because a
    web-based TalkingHead avatar cannot stream a multi-GB GLB.
    """
    if ratio >= 1.0 or ratio <= 0.0:
        log(f"  Decimation disabled (ratio = {ratio})")
        return
    before = len(mesh_obj.data.polygons)
    set_active(mesh_obj)
    dec = mesh_obj.modifiers.new(name="TH_Decimate", type="DECIMATE")
    dec.ratio = ratio
    dec.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=dec.name)
    after = len(mesh_obj.data.polygons)
    log(f"  Decimated mesh: {before:,} -> {after:,} polygons (ratio {ratio})")


def delete_reference_objects(ref_objs):
    """Remove the original reference objects so they are not exported."""
    log("Removing reference objects from scene...")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in ref_objs:
        if obj and obj.name in bpy.data.objects:
            obj.select_set(True)
    bpy.ops.object.delete(use_global=False, confirm=False)
    log("  Reference objects removed")


def remove_stray_objects(allowed_objs):
    """
    Delete any objects that are not the target armature or target meshes.
    Headless Blender can leave behind default primitives from some operators.
    """
    allowed_names = {o.name for o in allowed_objs if o}
    stray = [o for o in bpy.data.objects if o.name not in allowed_names]
    if stray:
        log(f"Removing {len(stray)} stray object(s): {[o.name for o in stray]}")
        bpy.ops.object.select_all(action="DESELECT")
        for o in stray:
            o.select_set(True)
        bpy.ops.object.delete(use_global=False, confirm=False)


# ---------------------------------------------------------------------------
# Blendshape / shape-key transfer
# ---------------------------------------------------------------------------

def ensure_basis(mesh_obj):
    if not mesh_obj.data.shape_keys:
        mesh_obj.shape_key_add(name="Basis", from_mix=False)


def list_shape_keys(mesh_obj):
    if not mesh_obj.data.shape_keys:
        return []
    return [kb.name for kb in mesh_obj.data.shape_keys.key_blocks[1:]]  # skip Basis


def sample_vertex_colors(obj):
    """
    Sample the base-color texture at each vertex's mean UV.
    Returns (co_world[n,3], rgb[n,3]) numpy arrays, or None if no texture.
    """
    import numpy as np

    me = obj.data
    n_verts = len(me.vertices)

    image = None
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.node_tree:
            continue
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image and node.image.size[0] > 0:
                if image is None or (node.image.size[0] > image.size[0]):
                    image = node.image
    if image is None:
        return None
    w, h = image.size
    px = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)

    uv_layer = me.uv_layers.active
    n_loops = len(me.loops)
    loop_uv = np.empty(n_loops * 2, dtype=np.float64)
    uv_layer.data.foreach_get("uv", loop_uv)
    loop_uv = loop_uv.reshape(-1, 2)
    loop_vidx = np.empty(n_loops, dtype=np.int64)
    me.loops.foreach_get("vertex_index", loop_vidx)
    uv_sum = np.zeros((n_verts, 2), dtype=np.float64)
    uv_cnt = np.zeros(n_verts, dtype=np.float64)
    np.add.at(uv_sum, loop_vidx, loop_uv)
    np.add.at(uv_cnt, loop_vidx, 1)
    uv = uv_sum / np.maximum(uv_cnt, 1)[:, None]

    ix = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(np.int64)
    iy = np.clip((uv[:, 1] % 1.0) * (h - 1), 0, h - 1).astype(np.int64)
    rgb = px[iy, ix, :3].astype(np.float64)

    co = np.empty(n_verts * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    mw = np.array(obj.matrix_world)
    co_w = co @ mw[:3, :3].T + mw[:3, 3]
    return co_w, rgb


def detect_eye_centers(target_obj):
    """
    Locate the character's two painted-eye centers (world space) by sampling
    the base-color texture at each vertex UV and clustering the white sclera
    vertices. Returns (left_center, right_center) as numpy arrays, or None.
    Character-left is world +X (the model faces -Y after yaw correction).
    """
    import numpy as np

    me = target_obj.data
    n_verts = len(me.vertices)

    image = None
    for slot in target_obj.material_slots:
        mat = slot.material
        if not mat or not mat.node_tree:
            continue
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image and node.image.size[0] > 0:
                if image is None or (node.image.size[0] > image.size[0]):
                    image = node.image
    if image is None:
        return None
    w, h = image.size
    px = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)

    uv_layer = me.uv_layers.active
    n_loops = len(me.loops)
    loop_uv = np.empty(n_loops * 2, dtype=np.float64)
    uv_layer.data.foreach_get("uv", loop_uv)
    loop_uv = loop_uv.reshape(-1, 2)
    loop_vidx = np.empty(n_loops, dtype=np.int64)
    me.loops.foreach_get("vertex_index", loop_vidx)
    uv_sum = np.zeros((n_verts, 2), dtype=np.float64)
    uv_cnt = np.zeros(n_verts, dtype=np.float64)
    np.add.at(uv_sum, loop_vidx, loop_uv)
    np.add.at(uv_cnt, loop_vidx, 1)
    uv = uv_sum / np.maximum(uv_cnt, 1)[:, None]

    ix = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(np.int64)
    iy = np.clip((uv[:, 1] % 1.0) * (h - 1), 0, h - 1).astype(np.int64)
    rgb = px[iy, ix, :3].astype(np.float64)

    co = np.empty(n_verts * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    mw = np.array(target_obj.matrix_world)
    co_w = co @ mw[:3, :3].T + mw[:3, 3]

    z_min, z_max = co_w[:, 2].min(), co_w[:, 2].max()
    height = z_max - z_min
    is_white = (rgb.min(axis=1) > 0.5) & (rgb.max(axis=1) - rgb.min(axis=1) < 0.35)
    cand = is_white & (co_w[:, 2] > z_min + 0.70 * height)
    if cand.sum() < 6:
        return None

    xs = co_w[cand, 0]
    c1, c2 = np.percentile(xs, 20), np.percentile(xs, 80)
    for _ in range(12):
        a1 = np.abs(xs - c1) <= np.abs(xs - c2)
        if a1.all() or (~a1).all():
            return None
        c1, c2 = xs[a1].mean(), xs[~a1].mean()
    pts = co_w[cand]
    left = pts[a1] if c1 > c2 else pts[~a1]
    right = pts[~a1] if c1 > c2 else pts[a1]
    return left.mean(axis=0), right.mean(axis=0)


def detect_painted_mouth(target_obj, eyes_t, eye_sep):
    """
    Locate the PAINTED mouth line from the base-color texture (a darker line
    below the eyes). Anatomy prior from the detected eyes; no donor needed.
    Returns (mouth_center_w, line_x, line_z, half_span) or None.
    """
    import numpy as np

    samp = sample_vertex_colors(target_obj)
    if samp is None:
        return None
    co_w, rgb = samp
    lum = rgb.mean(axis=1)
    E = (eyes_t[0] + eyes_t[1]) / 2
    region = ((np.abs(co_w[:, 0] - E[0]) < 0.55 * eye_sep) &
              (co_w[:, 2] > E[2] - 0.95 * eye_sep) &
              (co_w[:, 2] < E[2] - 0.35 * eye_sep) &
              (co_w[:, 1] < E[1] + 0.15 * eye_sep))
    if region.sum() < 20:
        return None
    med_lum = np.median(lum[region])
    dark_idx = np.where(region & (lum < 0.78 * med_lum))[0]
    if len(dark_idx) < 8:  # subtle line art: relax
        dark_idx = np.where(region & (lum < 0.88 * med_lum))[0]
    if len(dark_idx) < 8:
        return None
    zs = co_w[dark_idx, 2]
    medz = np.median(zs)
    madz = np.median(np.abs(zs - medz)) + 1e-6
    dark_idx = dark_idx[np.abs(zs - medz) < 3 * madz]
    if len(dark_idx) < 6:
        return None
    wgt = np.maximum(0.88 * med_lum - lum[dark_idx], 1e-4)
    center = (co_w[dark_idx] * wgt[:, None]).sum(0) / wgt.sum()
    xs = co_w[dark_idx, 0]
    half_span = (xs.max() - xs.min()) / 2
    bins = np.linspace(xs.min(), xs.max(), 10)
    which = np.clip(np.digitize(xs, bins) - 1, 0, 8)
    bx, bz = [], []
    for b in range(9):
        sel = which == b
        if sel.sum() > 0:
            bx.append(co_w[dark_idx[sel], 0].mean())
            bz.append(np.median(co_w[dark_idx[sel], 2]))
    if len(bx) < 3:
        return None
    order = np.argsort(bx)
    return center, np.array(bx)[order], np.array(bz)[order], half_span


def donor_face_landmarks(ref_objs, source_obj):
    """
    Donor (RPM) landmarks in world space: eye centers from the EyeLeft/EyeRight
    meshes, mouth center from the jawOpen shape key's displacement centroid.
    Returns (eyeL, eyeR, mouth) numpy arrays, or None.
    """
    import numpy as np
    from mathutils import Vector

    eyes = {}
    for obj in ref_objs:
        if obj.type != "MESH":
            continue
        for tag in ("EyeLeft", "EyeRight"):
            if tag.lower() in obj.name.lower():
                corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
                eyes[tag] = np.array(
                    [sum(v[i] for v in corners) / 8 for i in range(3)])
    if len(eyes) != 2:
        return None

    keys = source_obj.data.shape_keys
    kb = keys.key_blocks.get("jawOpen") if keys else None
    if kb is None:
        return None
    n = len(source_obj.data.vertices)
    kco = np.empty(n * 3, dtype=np.float64)
    kb.data.foreach_get("co", kco)
    bco = np.empty(n * 3, dtype=np.float64)
    keys.key_blocks[0].data.foreach_get("co", bco)
    kco, bco = kco.reshape(-1, 3), bco.reshape(-1, 3)
    d = np.linalg.norm(kco - bco, axis=1)
    strong = d > 0.25 * d.max()
    centroid_local = (bco[strong] * d[strong, None]).sum(axis=0) / d[strong].sum()
    mw = np.array(source_obj.matrix_world)
    mouth = centroid_local @ mw[:3, :3].T + mw[:3, 3]
    return eyes["EyeLeft"], eyes["EyeRight"], mouth


def ensure_mouth_material(obj):
    """Dark, double-sided material for the inner-mouth pocket."""
    name = "TH_MouthInterior"
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.02, 0.008, 0.006, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.95
        mat.use_backface_culling = False  # exports as doubleSided
    names = [m.name if m else "" for m in obj.data.materials]
    if name not in names:
        obj.data.materials.append(mat)
        names.append(name)
    return names.index(name)


def rip_mouth_and_build_cavity(target_obj, source_obj, mouth_w, eye_sep,
                               painted=None):
    """
    The Tripo mesh has SEALED lips: no matter how strong the morphs are, the
    mouth never opens into a cavity. Fix it surgically:
      1. classify target mouth verts as upper/lower lip by proximity to the
         donor's static/moving (jawOpen) lip vertices (donor already face-matched),
      2. rip the mesh open along the upper/lower class boundary,
      3. extrude the rip boundary into a dark inner-mouth pocket.
    Returns (cls, near_sta, near_mov) numpy arrays over the FINAL vertices:
    cls 0=untouched 1=upper 2=lower 3=pocket-depth; near_* are donor vertex
    indices used to override morph deltas per lip side. None on failure.
    """
    import numpy as np
    import bmesh
    from mathutils import Vector, Matrix, kdtree

    # ---- donor lip sets (world) --------------------------------------
    skeys = source_obj.data.shape_keys
    kb, basis_kb = skeys.key_blocks["jawOpen"], skeys.key_blocks[0]
    n_s = len(source_obj.data.vertices)
    kco = np.empty(n_s * 3); kb.data.foreach_get("co", kco); kco = kco.reshape(-1, 3)
    bco = np.empty(n_s * 3); basis_kb.data.foreach_get("co", bco); bco = bco.reshape(-1, 3)
    dmag = np.linalg.norm(kco - bco, axis=1)
    mw_s = np.array(source_obj.matrix_world)
    sco_w = bco @ mw_s[:3, :3].T + mw_s[:3, 3]

    # The jawOpen-probe landmark is chin/neck-biased (the jaw moves most).
    # The LIP LINE is what we must rip: re-anchor on the aligned donor's own
    # lips via mouthPucker, whose motion is concentrated on the lips.
    # (Fallback only: the painted-line anchor passed by the caller wins.)
    if painted is None:
        pk = skeys.key_blocks.get("mouthPucker") or skeys.key_blocks.get("viseme_U")
        if pk is not None:
            pco = np.empty(n_s * 3); pk.data.foreach_get("co", pco)
            pd = np.linalg.norm(pco.reshape(-1, 3) - bco, axis=1)
            top = pd > 0.5 * pd.max()
            if top.sum() >= 5:
                mouth_w = (sco_w[top] * pd[top, None]).sum(axis=0) / pd[top].sum()
                # The pucker centroid sits a touch below the visible lip line
                mouth_w = mouth_w + np.array([0.0, 0.0, 0.03 * eye_sep])
                log(f"  Mouth-rip: lip landmark re-anchored on donor lips "
                    f"(z={mouth_w[2]:.3f})")

    # ---- painted mouth line from the TEXTURE ---------------------------
    # The character's mouth is a darker painted line: detect it directly so
    # the rip follows the art instead of a geometric estimate.
    line_x = line_z = None
    half_span = None
    if painted is not None:
        mouth_w, line_x, line_z, half_span = painted
        mouth_w = np.asarray(mouth_w, dtype=np.float64)
        log(f"  Mouth-rip: using painted-mouth line from caller "
            f"(z={mouth_w[2]:.3f}, half-span {half_span*100:.1f}cm)")
    samp = None if painted is not None else sample_vertex_colors(target_obj)
    if samp is not None:
        tcw_all, trgb = samp
        lum = trgb.mean(axis=1)
        region = ((np.abs(tcw_all[:, 0] - mouth_w[0]) < 0.55 * eye_sep) &
                  (np.abs(tcw_all[:, 2] - mouth_w[2]) < 0.28 * eye_sep) &
                  (tcw_all[:, 1] < mouth_w[1] + 0.10 * eye_sep))
        log(f"  Mouth-rip: texture scan region={int(region.sum())} verts, "
            f"med_lum={np.median(lum[region]) if region.any() else -1:.3f}, "
            f"dark@0.78={int((region & (lum < 0.78*np.median(lum[region]))).sum()) if region.any() else 0}, "
            f"dark@0.88={int((region & (lum < 0.88*np.median(lum[region]))).sum()) if region.any() else 0}")
        if region.sum() > 20:
            med_lum = np.median(lum[region])
            dark_idx = np.where(region & (lum < 0.78 * med_lum))[0]
            if len(dark_idx) < 8:  # subtle line art: relax the threshold
                dark_idx = np.where(region & (lum < 0.88 * med_lum))[0]
            if len(dark_idx) >= 8:
                # trim vertical outliers (moles, shadows)
                zs = tcw_all[dark_idx, 2]
                medz = np.median(zs)
                madz = np.median(np.abs(zs - medz)) + 1e-6
                dark_idx = dark_idx[np.abs(zs - medz) < 3 * madz]
            if len(dark_idx) >= 8:
                wgt = (0.78 * med_lum - lum[dark_idx])
                mouth_w = (tcw_all[dark_idx] * wgt[:, None]).sum(0) / wgt.sum()
                xs = tcw_all[dark_idx, 0]
                half_span = (xs.max() - xs.min()) / 2
                bins = np.linspace(xs.min(), xs.max(), 10)
                which = np.clip(np.digitize(xs, bins) - 1, 0, 8)
                bx, bz = [], []
                for b in range(9):
                    sel = which == b
                    if sel.sum() > 0:
                        bx.append(tcw_all[dark_idx[sel], 0].mean())
                        bz.append(np.median(tcw_all[dark_idx[sel], 2]))
                if len(bx) >= 3:
                    order = np.argsort(bx)
                    line_x = np.array(bx)[order]
                    line_z = np.array(bz)[order]
                    log(f"  Mouth-rip: painted lip line detected "
                        f"({len(dark_idx)} dark verts, half-span "
                        f"{half_span*100:.1f}cm, z={mouth_w[2]:.3f})")

    near_mouth = np.linalg.norm(sco_w - mouth_w, axis=1) < 0.6 * eye_sep
    moving = (dmag > 0.35 * dmag.max()) & near_mouth
    static = (dmag < 0.10 * dmag.max()) & near_mouth
    if moving.sum() < 3 or static.sum() < 3:
        log("  Mouth-rip skipped: donor lip sets too small")
        return None

    def build_kd(mask):
        kd = kdtree.KDTree(int(mask.sum()))
        for idx in np.where(mask)[0]:
            kd.insert(Vector(sco_w[idx]), int(idx))
        kd.balance()
        return kd
    kd_mov, kd_sta = build_kd(moving), build_kd(static)

    # ---- classify target mouth verts ---------------------------------
    me = target_obj.data
    n_t = len(me.vertices)
    tco = np.empty(n_t * 3); me.vertices.foreach_get("co", tco); tco = tco.reshape(-1, 3)
    mw_t = np.array(target_obj.matrix_world)
    tco_w = tco @ mw_t[:3, :3].T + mw_t[:3, 3]
    rx = (1.10 * half_span) if line_x is not None else 0.45 * eye_sep
    ex = (tco_w[:, 0] - mouth_w[0]) / rx
    ez = (tco_w[:, 2] - mouth_w[2]) / (0.20 * eye_sep)
    front = tco_w[:, 1] < mouth_w[1] + 0.15 * eye_sep
    in_mouth = (ex * ex + ez * ez < 1.0) & front
    cls = np.zeros(n_t, dtype=np.int32)
    if line_x is not None:
        # Split along the painted lip curve
        lz = np.interp(tco_w[:, 0], line_x, line_z)
        for i in np.where(in_mouth)[0]:
            cls[i] = 1 if tco_w[i, 2] > lz[i] else 2
    else:
        for i in np.where(in_mouth)[0]:
            p = Vector(tco_w[i])
            dm = kd_mov.find(p)[2]
            ds = kd_sta.find(p)[2]
            cls[i] = 2 if dm < ds else 1

    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    edges = edges.reshape(-1, 2)
    # majority-smooth the classification so the seam is a clean line
    for _ in range(2):
        v1 = np.zeros(n_t); v2 = np.zeros(n_t)
        np.add.at(v1, edges[:, 0], (cls[edges[:, 1]] == 1).astype(float))
        np.add.at(v1, edges[:, 1], (cls[edges[:, 0]] == 1).astype(float))
        np.add.at(v2, edges[:, 0], (cls[edges[:, 1]] == 2).astype(float))
        np.add.at(v2, edges[:, 1], (cls[edges[:, 0]] == 2).astype(float))
        m = in_mouth & (v1 + v2 > 0)
        cls[m & (v1 > v2)] = 1
        cls[m & (v2 > v1)] = 2

    n_seam = int(((cls[edges[:, 0]] + cls[edges[:, 1]]) == 3).sum())
    if n_seam < 3:
        log("  Mouth-rip skipped: no seam edges found")
        return None
    log(f"  Mouth-rip: {int((cls==1).sum())} upper / {int((cls==2).sum())} lower "
        f"verts, {n_seam} seam edges")

    # Pre-surgery smooth normals (by quantized position): re-applied after the
    # rip as custom normals so the closed seam shades seamlessly at rest.
    pre_n = np.empty(n_t * 3); me.vertices.foreach_get("normal", pre_n)
    pre_n = pre_n.reshape(-1, 3)
    pre_lookup = {}
    for i, q in enumerate(map(tuple, np.round(tco / 1e-5).astype(np.int64))):
        pre_lookup.setdefault(q, i)

    # ---- rip + pocket in bmesh ---------------------------------------
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    lcls = bm.verts.layers.int.new("mclass")
    lseam = bm.verts.layers.int.new("mseam")
    for v in bm.verts:
        v[lcls] = int(cls[v.index])
    # Refine the seam: the base mesh has ~7mm edges, which makes the rip a
    # chunky staircase. Subdivide the crossing edges so the cut follows the
    # painted lip curve smoothly.
    crossing = [e for e in bm.edges
                if {e.verts[0][lcls], e.verts[1][lcls]} == {1, 2}]
    if crossing and line_x is not None:
        res = bmesh.ops.subdivide_edges(bm, edges=crossing, cuts=2)
        mw_t_m = Matrix(mw_t.tolist())
        for g in res["geom_inner"]:
            if isinstance(g, bmesh.types.BMVert):
                p_w = mw_t_m @ g.co
                lz_v = float(np.interp(p_w.x, line_x, line_z))
                g[lcls] = 1 if p_w.z > lz_v else 2
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()

    seam_edges = [e for e in bm.edges
                  if {e.verts[0][lcls], e.verts[1][lcls]} == {1, 2}]
    log(f"  Mouth-rip: seam refined to {len(seam_edges)} edges")
    for e in seam_edges:
        e.verts[0][lseam] = 1
        e.verts[1][lseam] = 1
    bmesh.ops.split_edges(bm, edges=seam_edges)

    # Rip copies carry ambiguous classes: re-derive each from the non-seam
    # verts of its linked faces (faces are entirely on one side of the rip).
    for v in bm.verts:
        if v[lseam] != 1:
            continue
        votes = {1: 0, 2: 0}
        for f in v.link_faces:
            for w in f.verts:
                if w is not v and w[lseam] == 0 and w[lcls] in (1, 2):
                    votes[w[lcls]] += 1
        if votes[1] != votes[2]:
            v[lcls] = 1 if votes[1] > votes[2] else 2

    # No synthetic membrane: the donor's real teeth + mouth interior are
    # grafted behind the aperture instead (see main()).

    bm.to_mesh(me)
    bm.free()
    me.update()

    # Restore pre-rip smooth shading across the (closed) seam
    n2 = len(me.vertices)
    tco2_l = np.empty(n2 * 3); me.vertices.foreach_get("co", tco2_l)
    tco2_l = tco2_l.reshape(-1, 3)
    cur_n = np.empty(n2 * 3); me.vertices.foreach_get("normal", cur_n)
    cur_n = cur_n.reshape(-1, 3)
    fixed_n = cur_n.copy()
    for i, q in enumerate(map(tuple, np.round(tco2_l / 1e-5).astype(np.int64))):
        j = pre_lookup.get(q)
        if j is not None:
            fixed_n[i] = pre_n[j]
    try:
        me.normals_split_custom_set_from_vertices(fixed_n.tolist())
    except Exception as e:
        log(f"  Mouth-rip: custom normals restore failed ({e})")

    # ---- final arrays over the new topology ---------------------------
    cls2 = np.zeros(n2, dtype=np.int32)
    attr = me.attributes.get("mclass")
    if attr is not None:
        tmp = np.empty(n2, dtype=np.int32)
        attr.data.foreach_get("value", tmp)
        cls2 = tmp
    tco2 = np.empty(n2 * 3); me.vertices.foreach_get("co", tco2)
    tco2_w = tco2.reshape(-1, 3) @ mw_t[:3, :3].T + mw_t[:3, 3]

    # Inverse-distance-weighted lookups over the 4 nearest donor lip verts:
    # single-nearest makes neighboring verts jump between donor references
    # and the lips crumple.
    K = 4
    idx_sta = np.zeros((n2, K), dtype=np.int64)
    w_sta = np.zeros((n2, K))
    idx_mov = np.zeros((n2, K), dtype=np.int64)
    w_mov = np.zeros((n2, K))
    for i in np.where(cls2 > 0)[0]:
        p = Vector(tco2_w[i])
        for kd, idxA, wA in ((kd_sta, idx_sta, w_sta), (kd_mov, idx_mov, w_mov)):
            found = kd.find_n(p, K)
            ws = np.array([1.0 / (f[2] + 1e-4) for f in found])
            ws /= ws.sum()
            for k, (_, j, _) in enumerate(found):
                idxA[i, k] = j
            wA[i, :len(found)] = ws

    # Feather: pure donor-override at the lips, fading into the Surface
    # Deform result toward the region border (hard switches leave creases).
    exf = (tco2_w[:, 0] - mouth_w[0]) / rx
    ezf = (tco2_w[:, 2] - mouth_w[2]) / (0.20 * eye_sep)
    r2 = np.sqrt(exf * exf + ezf * ezf)
    blend = np.clip((1.05 - r2) / 0.45, 0.0, 1.0)
    blend = blend * blend * (3 - 2 * blend)
    blend[cls2 == 0] = 0.0
    blend[cls2 == 3] = 1.0

    log(f"  Mouth-rip done: mesh {n_t} -> {n2} verts, "
        f"pocket verts={int((cls2==3).sum())}")
    return cls2, (idx_sta, w_sta, idx_mov, w_mov), blend


def build_mouth_crease(target_obj, source_obj, painted, eye_sep):
    """
    No-surgery mouth: the mesh stays CONTINUOUS (it can never tear).

    Two jobs:
    1. OVERRIDE the Surface Deform deltas in the whole mouth neighborhood.
       After the face-match scale-up the donor's mouth-bag interior sits
       close to the target's philtrum/chin skin, so SD binds some verts to
       the donor's INNER lower lip - they ride the jaw down while neighbors
       stay put (the faceted dent between nose and mouth). Replaced with a
       coherent field: above the painted line -> donor upper lip, below ->
       smooth ramp into jaw/lower-lip motion (clay-style stretch, zero
       divergence at the line itself), feathered into SD at the border.
    2. Deepen a shadowed crease along the painted lip line, proportional to
       how far the donor's lips separate in each key (claymation mouth).

    Returns dict with region ids, blend/ramp/crease weights and IDW lookups.
    """
    import numpy as np
    from mathutils import Vector, kdtree

    mouth_w, line_x, line_z, half_span = painted
    mouth_w = np.asarray(mouth_w, dtype=np.float64)

    # Donor lip sets (moving = lower lip/jaw, static = upper lip) near mouth
    skeys = source_obj.data.shape_keys
    kb, basis_kb = skeys.key_blocks["jawOpen"], skeys.key_blocks[0]
    n_s = len(source_obj.data.vertices)
    kco = np.empty(n_s * 3); kb.data.foreach_get("co", kco); kco = kco.reshape(-1, 3)
    bco = np.empty(n_s * 3); basis_kb.data.foreach_get("co", bco); bco = bco.reshape(-1, 3)
    dmag = np.linalg.norm(kco - bco, axis=1)
    mw_s = np.array(source_obj.matrix_world)
    sco_w = bco @ mw_s[:3, :3].T + mw_s[:3, 3]
    near = np.linalg.norm(sco_w - mouth_w, axis=1) < 0.6 * eye_sep
    moving = (dmag > 0.35 * dmag.max()) & near
    static = (dmag < 0.10 * dmag.max()) & near
    if moving.sum() < 3 or static.sum() < 3:
        log("  Mouth-crease skipped: donor lip sets too small")
        return None

    def build_kd(mask):
        kd = kdtree.KDTree(int(mask.sum()))
        for idx in np.where(mask)[0]:
            kd.insert(Vector(sco_w[idx]), int(idx))
        kd.balance()
        return kd
    kd_mov, kd_sta = build_kd(moving), build_kd(static)

    me = target_obj.data
    n_t = len(me.vertices)
    tco = np.empty(n_t * 3); me.vertices.foreach_get("co", tco); tco = tco.reshape(-1, 3)
    mw_t = np.array(target_obj.matrix_world)
    tco_w = tco @ mw_t[:3, :3].T + mw_t[:3, 3]

    # Signed height above the painted lip polyline (follows the smile curve)
    lz = np.interp(tco_w[:, 0], line_x, line_z)
    s = tco_w[:, 2] - lz
    dxn = (tco_w[:, 0] - mouth_w[0]) / (1.15 * half_span)
    front = tco_w[:, 1] < mouth_w[1] + 0.15 * eye_sep

    def smoothstep(t):
        t = np.clip(t, 0.0, 1.0)
        return t * t * (3.0 - 2.0 * t)

    # Override region: asymmetric ellipse (short above the line, long below
    # to cover the chin), feathered into the SD result toward the border.
    szn = np.where(s >= 0, s / (0.24 * eye_sep), s / (0.42 * eye_sep))
    r = np.sqrt(dxn * dxn + szn * szn)
    b = smoothstep((1.0 - r) / 0.35)
    b[~front] = 0.0
    ids = np.where(b > 0.02)[0]
    if len(ids) < 6:
        log("  Mouth-crease skipped: no verts on the painted line")
        return None

    # Upper-lip -> jaw ramp: 0 at/above the line, 1 from ~0.14*eye_sep below.
    ramp = smoothstep(-s[ids] / (0.14 * eye_sep))
    # Narrow gaussian band for the inward crease push along the line.
    dzg = s[ids] / (0.045 * eye_sep)
    dxg = (tco_w[ids, 0] - mouth_w[0]) / (1.05 * half_span)
    wg = np.exp(-dzg * dzg) * np.clip(1.0 - dxg * dxg, 0.0, 1.0)

    # Gaussian-kernel IDW: 1/d over few neighbors kinks wherever the
    # nearest-neighbor set changes between adjacent target verts (visible
    # faceting at full morph strength) - a wide gaussian stays C1-smooth.
    K = 8
    idx_sta = np.zeros((len(ids), K), dtype=np.int64)
    w_sta = np.zeros((len(ids), K))
    idx_mov = np.zeros((len(ids), K), dtype=np.int64)
    w_mov = np.zeros((len(ids), K))
    for r_i, i in enumerate(ids):
        p = Vector(tco_w[i])
        for kd, idxA, wA in ((kd_sta, idx_sta, w_sta), (kd_mov, idx_mov, w_mov)):
            found = kd.find_n(p, K)
            dists = np.array([f[2] for f in found])
            h = max(np.median(dists), 1e-4)
            ws = np.exp(-(dists / h) ** 2)
            ws /= ws.sum()
            for k, (_, j, _) in enumerate(found):
                idxA[r_i, k] = j
            wA[r_i, :len(found)] = ws

    R_tgt_inv = np.linalg.inv(mw_t[:3, :3])
    inward_l = np.array([0.0, 1.0, 0.0]) @ R_tgt_inv.T  # world +Y = into head
    log(f"  Mouth-crease: {len(ids)} verts in the mouth region "
        f"({int((wg > 0.05).sum())} on the painted line)")
    return {"ids": ids, "b": b[ids], "ramp": ramp, "wg": wg,
            "idx_sta": idx_sta, "w_sta": w_sta,
            "idx_mov": idx_mov, "w_mov": w_mov, "inward": inward_l}


def build_mouth_overlay(target_obj):
    """
    Sprite-mouth support (a "real" open mouth without mesh surgery): duplicate
    the mouth-region faces into a separate MouthOverlay mesh floating ~2mm in
    front of the skin. It inherits every shape key and the skin weights, so it
    deforms in lockstep with the face. Its UVs are remapped so the painted lip
    line sits at a CONSTANT V (0.625 from the bottom / 0.375 from the top in
    glTF space): a mouth drawn as a straight sprite in the app automatically
    follows the smile curve on the mesh. The material starts fully
    transparent; the app paints viseme-driven mouth shapes (dark cavity +
    teeth) onto a CanvasTexture at runtime (see avatar-controller.ts).
    """
    import numpy as np

    log("Building mouth sprite overlay...")
    eyes = detect_eye_centers(target_obj)
    if eyes is None:
        log("  Mouth-overlay skipped: no eye landmarks")
        return None
    sep = float(np.linalg.norm(eyes[0] - eyes[1]))
    painted = detect_painted_mouth(target_obj, eyes, sep)
    if painted is None:
        log("  Mouth-overlay skipped: painted mouth not found")
        return None
    mouth_w, line_x, line_z, half_span = painted
    mouth_w = np.asarray(mouth_w, dtype=np.float64)

    # Region box in painted-line space. MUST match drawMouth() in the app:
    # lip line at V_DOWN/(V_UP+V_DOWN) = 0.625 of V (0.375 from the top).
    U_HALF = 1.25 * half_span
    V_UP = 0.18 * sep
    V_DOWN = 0.30 * sep

    me_src = target_obj.data
    n_t = len(me_src.vertices)
    tco = np.empty(n_t * 3)
    me_src.vertices.foreach_get("co", tco)
    tco = tco.reshape(-1, 3)
    mw = np.array(target_obj.matrix_world)
    tco_w = tco @ mw[:3, :3].T + mw[:3, 3]
    lz = np.interp(tco_w[:, 0], line_x, line_z)
    s = tco_w[:, 2] - lz
    du = tco_w[:, 0] - mouth_w[0]
    keep = ((np.abs(du) < U_HALF) & (s > -V_DOWN) & (s < V_UP)
            & (tco_w[:, 1] < mouth_w[1] + 0.10 * sep))
    if keep.sum() < 12:
        log("  Mouth-overlay skipped: region too sparse")
        return None

    ov = target_obj.copy()
    ov.data = me_src.copy()
    ov.name = "MouthOverlay"
    ov.data.name = "MouthOverlayData"
    bpy.context.scene.collection.objects.link(ov)

    # Keep only the mouth-region faces (verts outside the region deleted;
    # any face touching them goes too, so kept faces lie fully in the box).
    # Edge/face select flags must be cleared FIRST: entering edit mode flushes
    # them down to the verts (imported meshes come fully selected, which
    # would otherwise delete the whole mesh).
    set_active(ov)
    bpy.context.tool_settings.mesh_select_mode = (True, False, False)
    for p in ov.data.polygons:
        p.select = False
    for e in ov.data.edges:
        e.select = False
    for v_i, k in zip(ov.data.vertices, keep):
        v_i.select = not bool(k)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")
    if len(ov.data.vertices) == 0 or len(ov.data.polygons) == 0:
        log("  Mouth-overlay skipped: region deletion left no faces")
        bpy.data.objects.remove(ov, do_unlink=True)
        return None

    me = ov.data
    n_o = len(me.vertices)
    oco = np.empty(n_o * 3)
    me.vertices.foreach_get("co", oco)
    oco = oco.reshape(-1, 3)
    oco_w = oco @ mw[:3, :3].T + mw[:3, 3]
    lz_o = np.interp(oco_w[:, 0], line_x, line_z)
    u = 0.5 + (oco_w[:, 0] - mouth_w[0]) / (2.0 * U_HALF)
    v = ((oco_w[:, 2] - lz_o) + V_DOWN) / (V_UP + V_DOWN)

    loops_v = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", loops_v)
    uv = np.stack([u[loops_v], v[loops_v]], axis=1)
    me.uv_layers[0].data.foreach_set("uv", uv.reshape(-1))

    # Float 2mm in front of the skin along vertex normals (every shape key
    # gets the same offset, so the gap survives all morphs - no z-fighting).
    nrm = np.empty(n_o * 3)
    me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(-1, 3)
    scale = float(np.cbrt(abs(np.linalg.det(mw[:3, :3]))))
    off = nrm * (0.002 / max(scale, 1e-6))
    if me.shape_keys:
        for kb in me.shape_keys.key_blocks:
            arr = np.empty(n_o * 3)
            kb.data.foreach_get("co", arr)
            kb.data.foreach_set("co", (arr.reshape(-1, 3) + off).reshape(-1))
    me.vertices.foreach_set("co", (oco + off).reshape(-1))

    # Fully transparent placeholder texture; the app swaps in a CanvasTexture.
    img = bpy.data.images.new("MouthOverlayTex", 16, 16, alpha=True)
    img.pixels = [0.0] * (16 * 16 * 4)
    img.pack()
    mat = bpy.data.materials.new("MouthOverlayMat")
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    texn = mat.node_tree.nodes.new("ShaderNodeTexImage")
    texn.image = img
    mat.node_tree.links.new(bsdf.inputs["Base Color"], texn.outputs["Color"])
    mat.node_tree.links.new(bsdf.inputs["Alpha"], texn.outputs["Alpha"])
    bsdf.inputs["Roughness"].default_value = 0.9
    for attr, val in (("blend_method", "BLEND"),
                      ("surface_render_method", "BLENDED")):
        try:
            setattr(mat, attr, val)
        except (AttributeError, TypeError):
            pass
    me.materials.clear()
    me.materials.append(mat)

    log(f"  Mouth-overlay: {n_o} verts, {len(me.polygons)} faces, "
        f"U half {U_HALF*100:.1f}cm, V +{V_UP*100:.1f}/-{V_DOWN*100:.1f}cm")
    return ov


def transfer_shape_keys_surface_deform(target_obj, source_obj, ref_objs=None):
    """
    Transfer every non-Basis shape key from source_obj to target_obj using the
    Surface Deform modifier. This works even when the two meshes have different
    topology. If ref_objs is given, the donor head is first scaled/positioned
    so its eyes and mouth land exactly on the target's (cartoon faces have
    much larger features than the RPM donor - without this the deformations
    arrive diluted and misplaced).
    """
    log(f"Transferring shape keys from {source_obj.name} to {target_obj.name}...")
    ensure_basis(target_obj)

    source_keys = list_shape_keys(source_obj)
    if not source_keys:
        log("  WARNING: source mesh has no shape keys to transfer")
        return

    log(f"  Source shape keys: {len(source_keys)}")

    # CRITICAL: bind must happen with the source at rest. Surface Deform uses the
    # source's state AT BIND TIME as the reference; binding with a key already at
    # 1.0 makes every transferred delta ~zero (the bug that produced no-op morphs).
    for kb in source_obj.data.shape_keys.key_blocks:
        kb.value = 0.0
    bpy.context.view_layer.update()

    set_active(target_obj)

    def bind_sd():
        mod = target_obj.modifiers.new(name="TH_SurfaceDeform", type="SURFACE_DEFORM")
        mod.target = source_obj
        # Move to top so it deforms the undeformed base mesh (before Armature)
        while target_obj.modifiers.find(mod.name) > 0:
            bpy.ops.object.modifier_move_up(modifier=mod.name)
        ok = bpy.ops.object.surfacedeform_bind(modifier=mod.name)
        if "CANCELLED" in str(ok) or not mod.is_bound:
            target_obj.modifiers.remove(mod)
            raise RuntimeError(
                "Surface Deform bind failed (source/target too dissimilar?)")
        return mod

    sd = bind_sd()

    # Disable every other modifier during capture so evaluated coords contain
    # only the Surface Deform result (armature at rest would be a no-op anyway,
    # but this keeps the capture clean).
    disabled = []
    for mod in target_obj.modifiers:
        if mod.name != sd.name and mod.show_viewport:
            mod.show_viewport = False
            disabled.append(mod.name)

    n_verts = len(target_obj.data.vertices)

    def capture_coords():
        deps = bpy.context.evaluated_depsgraph_get()
        eval_obj = target_obj.evaluated_get(deps)
        me = eval_obj.to_mesh()
        if len(me.vertices) != n_verts:
            eval_obj.to_mesh_clear()
            raise RuntimeError(
                f"Evaluated vertex count mismatch ({len(me.vertices)} != {n_verts})")
        coords = [0.0] * (n_verts * 3)
        me.vertices.foreach_get("co", coords)
        eval_obj.to_mesh_clear()
        return coords

    import numpy as np

    # Rest-state capture. Deltas are computed against THIS (the Surface Deform
    # output with the source at rest), not against the Basis: that cancels the
    # uniform bind noise that otherwise pollutes every vertex of every key.
    rest = np.array(capture_coords(), dtype=np.float64).reshape(-1, 3)

    # ---- Face-match alignment ------------------------------------------
    # Rescale/position the donor so eyes and mouth coincide with the target's.
    # Runs TWICE: the first jawOpen probe uses the coarse body-level binding,
    # so the mouth estimate (and thus the vertical scale) improves once the
    # donor is roughly in place. Also pins the donor's face SURFACE depth to
    # the target's at eye level (eye centers alone would sink it into the head).
    mouth_final = None
    sep_t = None
    eyes_t = detect_eye_centers(target_obj) if ref_objs is not None else None
    if eyes_t is not None:
        from mathutils import Matrix, Vector

        eyeL_t, eyeR_t = eyes_t
        E_t = (eyeL_t + eyeR_t) / 2
        sep_t = np.linalg.norm(eyeL_t - eyeR_t)
        mw_t = np.array(target_obj.matrix_world)

        # Target face-front depth at eye level (character faces -Y)
        co_t_w = rest @ mw_t[:3, :3].T + mw_t[:3, 3]
        band_t = np.abs(co_t_w[:, 2] - E_t[2]) < 0.35 * sep_t
        front_t = co_t_w[band_t, 1].min() if band_t.any() else None

        donor_eye_objs = [
            o for o in (ref_objs or []) if o.type == "MESH"
            and ("eyeleft" in o.name.lower() or "eyeright" in o.name.lower()
                 or "teeth" in o.name.lower())]

        # Anchor the mouth on the PAINTED lip line when the texture allows:
        # the jawOpen probe is chin-biased and lands centimeters too low,
        # which also misplaces the grafted teeth.
        painted = detect_painted_mouth(target_obj, eyes_t, sep_t)
        if painted is not None:
            mouth_final = painted[0]
            log(f"  Face-match: painted-mouth anchor z={painted[0][2]:.3f} "
                f"(half-span {painted[3]*100:.1f}cm)")

        def move_donor(mat):
            source_obj.matrix_world = mat @ source_obj.matrix_world
            for o in donor_eye_objs:
                o.matrix_world = mat @ o.matrix_world
            bpy.context.view_layer.update()

        for it in range(2):
            donor_lm = donor_face_landmarks(ref_objs, source_obj)
            if donor_lm is None:
                log("  Face-match: donor landmarks unavailable, stopping")
                break

            if painted is not None:
                mouth_t = painted[0]
            else:
                # Probe where jawOpen lands with the CURRENT binding
                source_obj.data.shape_keys.key_blocks["jawOpen"].value = 1.0
                bpy.context.view_layer.update()
                probe = np.array(capture_coords(), dtype=np.float64).reshape(-1, 3)
                source_obj.data.shape_keys.key_blocks["jawOpen"].value = 0.0
                bpy.context.view_layer.update()
                d = np.linalg.norm(probe - rest, axis=1)
                if d.max() <= 1e-4:
                    log("  Face-match: jawOpen probe produced no motion, stopping")
                    break
                strong = d > 0.25 * d.max()
                mouth_local = (rest[strong] * d[strong, None]).sum(axis=0) / d[strong].sum()
                mouth_t = mouth_local @ mw_t[:3, :3].T + mw_t[:3, 3]
            mouth_final = mouth_t

            eyeL_d, eyeR_d, mouth_d = donor_lm
            E_d = (eyeL_d + eyeR_d) / 2
            sep_d = np.linalg.norm(eyeL_d - eyeR_d)
            face_t = E_t[2] - mouth_t[2]
            face_d = E_d[2] - mouth_d[2]
            s_xy = sep_t / sep_d
            s_z = face_t / face_d if face_d > 1e-4 else s_xy
            if not (0.4 < s_xy < 6.0 and 0.4 < s_z < 6.0):
                log(f"  Face-match it{it+1}: implausible scale "
                    f"x={s_xy:.2f} z={s_z:.2f}, stopping")
                break
            move_donor(Matrix.Translation(Vector(E_t))
                       @ Matrix.Diagonal(Vector((s_xy, s_xy, s_z, 1.0)))
                       @ Matrix.Translation(-Vector(E_d)))

            # Depth correction: donor face front -> target face front
            dy = 0.0
            if front_t is not None:
                n_s = len(source_obj.data.vertices)
                sco = np.empty(n_s * 3, dtype=np.float64)
                source_obj.data.vertices.foreach_get("co", sco)
                sco = sco.reshape(-1, 3)
                mw_s = np.array(source_obj.matrix_world)
                sco_w = sco @ mw_s[:3, :3].T + mw_s[:3, 3]
                band_s = np.abs(sco_w[:, 2] - E_t[2]) < 0.35 * sep_t
                if band_s.any():
                    dy = float(front_t - sco_w[band_s, 1].min())
                    move_donor(Matrix.Translation(Vector((0.0, dy, 0.0))))

            log(f"  Face-match it{it+1}: eye sep x{s_xy:.2f}, eye-mouth x{s_z:.2f}, "
                f"depth {dy*100:+.1f}cm; rebinding")
            target_obj.modifiers.remove(sd)
            sd = bind_sd()
            rest = np.array(capture_coords(), dtype=np.float64).reshape(-1, 3)
    else:
        log("  Face-match skipped: landmarks unavailable")
    # ---------------------------------------------------------------------

    # ---- Mouth crease (no-surgery approach) ------------------------------
    # Ripping the mesh open tore apart in live use. Keep the mesh CONTINUOUS
    # and deepen a shadowed crease along the painted lip line instead.
    mouth_cls = None  # (kept for the weld-exclusion check below)
    crease = None
    if eyes_t is not None and painted is not None and sep_t is not None:
        crease = build_mouth_crease(target_obj, source_obj, painted, sep_t)
    # ---------------------------------------------------------------------

    basis = np.empty(n_verts * 3, dtype=np.float64)
    target_obj.data.shape_keys.key_blocks["Basis"].data.foreach_get("co", basis)
    basis = basis.reshape(-1, 3)

    # Weld groups: UV seams duplicate vertices at identical positions. If the
    # duplicates receive different deltas the mesh visibly cracks along the
    # seam, so smoothing must flow across them and their deltas must match.
    from collections import defaultdict
    quant = np.round(basis / 1e-5).astype(np.int64)
    groups = defaultdict(list)
    for i, k in enumerate(map(tuple, quant)):
        groups[k].append(i)
    weld_groups = [np.array(v, dtype=np.int64)
                   for v in groups.values() if len(v) > 1]
    # The mouth rip intentionally duplicates verts along the lip seam: those
    # pairs must NOT be welded back or the mouth can never open.
    if mouth_cls is not None:
        weld_groups = [g for g in weld_groups if not (mouth_cls[g] > 0).any()]
    log(f"  Welded {sum(len(g) for g in weld_groups)} seam-duplicate verts "
        f"in {len(weld_groups)} groups")

    # Vertex adjacency for delta smoothing (+ weld bridges across UV seams)
    edges = np.empty(len(target_obj.data.edges) * 2, dtype=np.int64)
    target_obj.data.edges.foreach_get("vertices", edges)
    edges = edges.reshape(-1, 2)
    bridges = [np.stack([g[:-1], g[1:]], axis=1) for g in weld_groups]
    if bridges:
        edges = np.concatenate([edges] + bridges, axis=0)
    nbr_count = np.zeros(n_verts, dtype=np.float64)
    np.add.at(nbr_count, edges[:, 0], 1)
    np.add.at(nbr_count, edges[:, 1], 1)
    nbr_count = np.maximum(nbr_count, 1)[:, None]

    NOISE_EPS = 0.0005   # 0.5 mm: below this a delta is bind noise, zero it
    SMOOTH_ITERS = 3     # Laplacian passes: heals verts bound across lip seams
    SMOOTH_LAMBDA = 0.6

    def clean_delta(delta):
        for _ in range(SMOOTH_ITERS):
            acc = np.zeros_like(delta)
            np.add.at(acc, edges[:, 0], delta[edges[:, 1]])
            np.add.at(acc, edges[:, 1], delta[edges[:, 0]])
            delta = delta + SMOOTH_LAMBDA * (acc / nbr_count - delta)
        # Soft threshold: zero below EPS (keeps the sparse export), but ramp
        # back to full over EPS..2*EPS - a hard cutoff leaves visible sub-mm
        # steps (faceting) where neighbors straddle the threshold.
        mag = np.linalg.norm(delta, axis=1)
        t = np.clip((mag - NOISE_EPS) / NOISE_EPS, 0.0, 1.0)
        delta *= (t * t * (3.0 - 2.0 * t))[:, None]
        # Equalize weld duplicates so seams can never crack
        for g in weld_groups:
            delta[g] = delta[g].mean(axis=0)
        return delta

    # Donor-space precomputations for the mouth crease
    if crease is not None:
        n_src = len(source_obj.data.vertices)
        src_basis = np.empty(n_src * 3, dtype=np.float64)
        source_obj.data.shape_keys.key_blocks[0].data.foreach_get("co", src_basis)
        src_basis = src_basis.reshape(-1, 3)
        R_src = np.array(source_obj.matrix_world)[:3, :3]
        R_tgt_inv = np.linalg.inv(np.array(target_obj.matrix_world)[:3, :3])

    transferred = []
    failed = []

    for idx, sk_name in enumerate(source_keys, 1):
        try:
            for kb in source_obj.data.shape_keys.key_blocks:
                kb.value = 0.0
            source_obj.data.shape_keys.key_blocks[sk_name].value = 1.0
            bpy.context.view_layer.update()

            coords = np.array(capture_coords(), dtype=np.float64).reshape(-1, 3)
            delta = coords - rest
            # Mouth region: replace the SD deltas (garbage near the donor's
            # mouth bag) with the coherent upper-lip -> jaw field, then deepen
            # the lip crease by how far the donor's lips separate in this key.
            # The mesh stays continuous so it can never tear.
            if crease is not None:
                kdat = np.empty(n_src * 3, dtype=np.float64)
                source_obj.data.shape_keys.key_blocks[sk_name].data.foreach_get(
                    "co", kdat)
                dloc = ((kdat.reshape(-1, 3) - src_basis) @ R_src.T) @ R_tgt_inv.T

                def idw(idxA, wA):
                    return (dloc[idxA] * wA[:, :, None]).sum(axis=1)

                sta_d = idw(crease["idx_sta"], crease["w_sta"])
                mov_d = idw(crease["idx_mov"], crease["w_mov"])
                ids = crease["ids"]
                d_over = sta_d + crease["ramp"][:, None] * (mov_d - sta_d)
                b = crease["b"][:, None]
                delta[ids] = (1.0 - b) * delta[ids] + b * d_over
                sep_l = np.linalg.norm(mov_d - sta_d, axis=1)
                push = np.minimum(sep_l, 0.035) * 0.65 * crease["wg"]
                delta[ids] += push[:, None] * crease["inward"][None, :]
            delta = clean_delta(delta)
            # Sealed continuous mouth: a moderate gain keeps speech readable
            # without distorting the face (the mesh cannot tear by design).
            if sk_name.startswith("viseme_"):
                delta *= 1.25
            max_delta = float(np.linalg.norm(delta, axis=1).max())

            new_key = target_obj.shape_key_add(name=sk_name, from_mix=False)
            new_key.data.foreach_set("co", (basis + delta).reshape(-1))

            transferred.append(sk_name)
            log(f"  [{idx}/{len(source_keys)}] Transferred: {sk_name} "
                f"(max delta {max_delta*100:.2f} cm)")
        except Exception as e:
            failed.append((sk_name, str(e)))
            log(f"  [{idx}/{len(source_keys)}] FAILED: {sk_name} -> {e}")

    # Reset source keys and clean up
    for kb in source_obj.data.shape_keys.key_blocks:
        kb.value = 0.0
    target_obj.modifiers.remove(sd)
    for name in disabled:
        target_obj.modifiers[name].show_viewport = True
    bpy.context.view_layer.update()

    log(f"  Transferred {len(transferred)}/{len(source_keys)} shape keys")
    if failed:
        log(f"  Failed: {len(failed)}")
        for name, err in failed[:10]:
            log(f"    - {name}: {err}")


def build_procedural_blink(target_obj):
    """
    The character's eyes are PAINTED on the face mesh (no separate lids or
    eyeballs), so lid shapes cannot transfer from the RPM donor via Surface
    Deform. Instead: locate the two white sclera regions by sampling the
    base-color texture at each vertex UV, then author eyeBlinkLeft/Right and
    eyesClosed as a vertical squash of each eye region (standard cartoon-eye
    blink). Also derives eyeSquint*/eyeWide* as scaled variants.
    """
    import numpy as np

    log("Building procedural cartoon-eye blink shapes...")
    me = target_obj.data
    n_verts = len(me.vertices)

    # --- base-color image ---
    image = None
    for slot in target_obj.material_slots:
        mat = slot.material
        if not mat or not mat.node_tree:
            continue
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image and node.image.size[0] > 0:
                if image is None or (node.image.size[0] > image.size[0]):
                    image = node.image
    if image is None:
        log("  WARNING: no base-color image found; skipping procedural blink")
        return
    w, h = image.size
    px = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)

    # --- per-vertex mean UV ---
    uv_layer = me.uv_layers.active
    n_loops = len(me.loops)
    loop_uv = np.empty(n_loops * 2, dtype=np.float64)
    uv_layer.data.foreach_get("uv", loop_uv)
    loop_uv = loop_uv.reshape(-1, 2)
    loop_vidx = np.empty(n_loops, dtype=np.int64)
    me.loops.foreach_get("vertex_index", loop_vidx)
    uv_sum = np.zeros((n_verts, 2), dtype=np.float64)
    uv_cnt = np.zeros(n_verts, dtype=np.float64)
    np.add.at(uv_sum, loop_vidx, loop_uv)
    np.add.at(uv_cnt, loop_vidx, 1)
    uv = uv_sum / np.maximum(uv_cnt, 1)[:, None]

    # --- sample color per vertex (nearest pixel) ---
    ix = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(np.int64)
    iy = np.clip((uv[:, 1] % 1.0) * (h - 1), 0, h - 1).astype(np.int64)
    rgb = px[iy, ix, :3].astype(np.float64)

    co = np.empty(n_verts * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    # World-space (object transforms may not be applied yet at this stage)
    mw = np.array(target_obj.matrix_world)
    co_w = co @ mw[:3, :3].T + mw[:3, 3]

    z_min, z_max = co_w[:, 2].min(), co_w[:, 2].max()
    height = z_max - z_min

    # --- white sclera candidates in the head band ---
    whiteness = rgb.min(axis=1)
    chroma = rgb.max(axis=1) - rgb.min(axis=1)
    is_white = (whiteness > 0.5) & (chroma < 0.35)
    in_head = co_w[:, 2] > z_min + 0.70 * height
    cand = is_white & in_head
    if cand.sum() < 10:
        log(f"  WARNING: only {cand.sum()} sclera vertices found; skipping blink")
        return

    # Split sclera candidates into the two eyes with 1-D 2-means on x
    # (a plain median split fails when highlights skew the distribution).
    cand_idx = np.where(cand)[0]
    xs = co_w[cand_idx, 0]
    c1, c2 = np.percentile(xs, 20), np.percentile(xs, 80)
    for _ in range(12):
        assign1 = np.abs(xs - c1) <= np.abs(xs - c2)
        if assign1.all() or (~assign1).all():
            break
        c1, c2 = xs[assign1].mean(), xs[~assign1].mean()

    def trimmed(mask_1d):
        """Drop outliers > 2.5 MAD from the cluster median (x and z)."""
        idx = cand_idx[mask_1d]
        for axis in (0, 2):
            v = co_w[idx, axis]
            med = np.median(v)
            mad = np.median(np.abs(v - med)) + 1e-6
            idx = idx[np.abs(co_w[idx, axis] - med) < 2.5 * mad]
        m = np.zeros(n_verts, dtype=bool)
        m[idx] = True
        return m

    cluster1, cluster2 = trimmed(assign1), trimmed(~assign1)
    # Character faces -Y after yaw correction: character-left is world +X
    if co_w[cluster1, 0].mean() > co_w[cluster2, 0].mean():
        sides = {"Left": cluster1, "Right": cluster2}
    else:
        sides = {"Left": cluster2, "Right": cluster1}
    log(f"  sclera candidates: {cand.sum()} -> clusters "
        f"L={sides['Left'].sum()} R={sides['Right'].sum()}")

    def key_from_delta(name, delta):
        kb = me.shape_keys.key_blocks.get(name) if me.shape_keys else None
        if kb:
            target_obj.shape_key_remove(kb)
        new_key = target_obj.shape_key_add(name=name, from_mix=False)
        new_key.data.foreach_set("co", (co + delta).reshape(-1))
        return new_key

    # Few sclera verts are enough to locate CENTERS, but not to measure the
    # eye size. Derive radii anatomically from the eye separation instead.
    eye_sep = abs(co_w[sides["Left"], 0].mean() - co_w[sides["Right"], 0].mean())

    blink_deltas = {}
    for side, mask in sides.items():
        pts = co_w[mask]
        center = pts.mean(axis=0)
        # Generous radii: the sparse sclera verts underestimate the painted
        # eye, and an undersized region leaves the lids half-open.
        rx = max((pts[:, 0].max() - pts[:, 0].min()) / 2 * 1.45, 0.26 * eye_sep)
        rz = max((pts[:, 2].max() - pts[:, 2].min()) / 2 * 1.65, 0.18 * eye_sep)

        dx = (co_w[:, 0] - center[0]) / rx
        dz = (co_w[:, 2] - center[2]) / rz
        # Only the front of the head (avoid wrapping to hair behind)
        front = co_w[:, 1] < np.median(co_w[cand, 1]) + 0.05 * height
        # FULL effect inside the eye ellipse (r<=1), fading out to r=1.5:
        # the squash must be strongest at the lid edges, not the eye center.
        r = np.sqrt(dx * dx + dz * dz)
        t = np.clip((1.5 - r) / 0.5, 0.0, 1.0)
        t = t * t * (3 - 2 * t)  # smoothstep
        t[~front] = 0.0

        # Vertical squash toward the lid line: upper verts drop fully so the
        # eye closes COMPLETELY, lower verts rise to meet them.
        z_off = co_w[:, 2] - center[2]
        factor = np.where(z_off > 0, 1.0, 0.55)
        delta_w = np.zeros_like(co_w)
        delta_w[:, 2] = -z_off * factor * t

        # Back to object space
        delta = delta_w @ np.linalg.inv(mw[:3, :3]).T
        blink_deltas[side] = delta

        n_moved = int((np.linalg.norm(delta, axis=1) > 0.0005).sum())
        log(f"  eyeBlink{side}: eye center=({center[0]:.3f},{center[2]:.3f}) "
            f"rx={rx:.3f} rz={rz:.3f} verts moved={n_moved}")
        key_from_delta(f"eyeBlink{side}", delta)
        key_from_delta(f"eyeSquint{side}", delta * 0.35)
        key_from_delta(f"eyeWide{side}", delta * -0.22)

    key_from_delta("eyesClosed", blink_deltas["Left"] + blink_deltas["Right"])
    log("  Procedural blink shapes done")


# ---------------------------------------------------------------------------
# Post-processing helpers (build visemes/extras + addon ops)
# ---------------------------------------------------------------------------

def run_visemes_from_arkit():
    """Execute the build-visemes-from-arkit.py logic inline."""
    log("Building Oculus visemes from ARKit blend shapes...")
    shapekeys = [
        {"name": "viseme_aa", "mix": [{"name": "jawOpen", "value": 0.6}]},
        {"name": "viseme_E", "mix": [
            {"name": "mouthPressLeft", "value": 0.8},
            {"name": "mouthPressRight", "value": 0.8},
            {"name": "mouthDimpleLeft", "value": 1.0},
            {"name": "mouthDimpleRight", "value": 1.0},
            {"name": "jawOpen", "value": 0.3}
        ]},
        {"name": "viseme_I", "mix": [
            {"name": "mouthPressLeft", "value": 0.6},
            {"name": "mouthPressRight", "value": 0.6},
            {"name": "mouthDimpleLeft", "value": 0.6},
            {"name": "mouthDimpleRight", "value": 0.6},
            {"name": "jawOpen", "value": 0.2}
        ]},
        {"name": "viseme_O", "mix": [
            {"name": "mouthPucker", "value": 1.0},
            {"name": "jawForward", "value": 0.6},
            {"name": "jawOpen", "value": 0.2}
        ]},
        {"name": "viseme_U", "mix": [{"name": "mouthFunnel", "value": 1.0}]},
        {"name": "viseme_PP", "mix": [
            {"name": "mouthRollLower", "value": 0.8},
            {"name": "mouthRollUpper", "value": 0.8},
            {"name": "mouthUpperUpLeft", "value": 0.3},
            {"name": "mouthUpperUpRight", "value": 0.3}
        ]},
        {"name": "viseme_FF", "mix": [
            {"name": "mouthPucker", "value": 1.0},
            {"name": "mouthShrugUpper", "value": 1.0},
            {"name": "mouthLowerDownLeft", "value": 0.2},
            {"name": "mouthLowerDownRight", "value": 0.2},
            {"name": "mouthDimpleLeft", "value": 1.0},
            {"name": "mouthDimpleRight", "value": 1.0},
            {"name": "mouthRollLower", "value": 1.0}
        ]},
        {"name": "viseme_DD", "mix": [
            {"name": "mouthPressLeft", "value": 0.8},
            {"name": "mouthPressRight", "value": 0.8},
            {"name": "mouthFunnel", "value": 0.5},
            {"name": "jawOpen", "value": 0.2}
        ]},
        {"name": "viseme_SS", "mix": [
            {"name": "mouthPressLeft", "value": 0.8},
            {"name": "mouthPressRight", "value": 0.8},
            {"name": "mouthLowerDownLeft", "value": 0.5},
            {"name": "mouthLowerDownRight", "value": 0.5},
            {"name": "jawOpen", "value": 0.1}
        ]},
        {"name": "viseme_TH", "mix": [
            {"name": "mouthRollUpper", "value": 0.6},
            {"name": "jawOpen", "value": 0.2},
            {"name": "tongueOut", "value": 0.4}
        ]},
        {"name": "viseme_CH", "mix": [
            {"name": "mouthPucker", "value": 0.5},
            {"name": "jawOpen", "value": 0.2}
        ]},
        {"name": "viseme_RR", "mix": [
            {"name": "mouthPucker", "value": 0.5},
            {"name": "jawOpen", "value": 0.2}
        ]},
        {"name": "viseme_kk", "mix": [
            {"name": "mouthLowerDownLeft", "value": 0.4},
            {"name": "mouthLowerDownRight", "value": 0.4},
            {"name": "mouthDimpleLeft", "value": 0.3},
            {"name": "mouthDimpleRight", "value": 0.3},
            {"name": "mouthFunnel", "value": 0.3},
            {"name": "mouthPucker", "value": 0.3},
            {"name": "jawOpen", "value": 0.15}
        ]},
        {"name": "viseme_nn", "mix": [
            {"name": "mouthLowerDownLeft", "value": 0.4},
            {"name": "mouthLowerDownRight", "value": 0.4},
            {"name": "mouthDimpleLeft", "value": 0.3},
            {"name": "mouthDimpleRight", "value": 0.3},
            {"name": "mouthFunnel", "value": 0.3},
            {"name": "mouthPucker", "value": 0.3},
            {"name": "jawOpen", "value": 0.15},
            {"name": "tongueOut", "value": 0.2}
        ]},
        {"name": "viseme_sil", "mix": []}
    ]

    def traverse(x):
        yield x
        if hasattr(x, "children"):
            for c in x.children:
                yield from traverse(c)

    def has_shapekeys(x):
        return hasattr(x, "data") and hasattr(x.data, "shape_keys") and x.data.shape_keys is not None

    count = 0
    for r in bpy.context.scene.objects:
        for o in traverse(r):
            if not has_shapekeys(o):
                continue
            keys = o.data.shape_keys.key_blocks
            for b in shapekeys:
                name = b["name"]
                mix = b["mix"]
                if keys.get(name) is not None:
                    continue
                for m in mix:
                    if keys.get(m["name"]) is not None:
                        for k in keys:
                            k.value = 0
                        for m2 in mix:
                            kb = keys.get(m2["name"])
                            if kb is not None:
                                kb.value = m2["value"]
                        o.shape_key_add(name=name, from_mix=True)
                        for k in keys:
                            k.value = 0
                        count += 1
                        break
    log(f"  Created/verified {count} Oculus viseme shape keys")


def run_extras_from_arkit():
    """Execute the build-extras-from-arkit.py logic inline."""
    log("Building convenience extras from ARKit blend shapes...")
    shapekeys = [
        {"name": "mouthOpen", "mix": [{"name": "jawOpen", "value": 0.7}]},
        {"name": "mouthSmile", "mix": [
            {"name": "mouthSmileLeft", "value": 1.0},
            {"name": "mouthSmileRight", "value": 1.0}
        ]},
        {"name": "eyesClosed", "mix": [
            {"name": "eyeBlinkLeft", "value": 1.0},
            {"name": "eyeBlinkRight", "value": 1.0}
        ]},
        {"name": "eyesLookUp", "mix": [
            {"name": "eyeLookUpLeft", "value": 1.0},
            {"name": "eyeLookUpRight", "value": 1.0}
        ]},
        {"name": "eyesLookDown", "mix": [
            {"name": "eyeLookDownLeft", "value": 1.0},
            {"name": "eyeLookDownRight", "value": 1.0}
        ]}
    ]

    def traverse(x):
        yield x
        if hasattr(x, "children"):
            for c in x.children:
                yield from traverse(c)

    def has_shapekeys(x):
        return hasattr(x, "data") and hasattr(x.data, "shape_keys") and x.data.shape_keys is not None

    count = 0
    for r in bpy.context.scene.objects:
        for o in traverse(r):
            if not has_shapekeys(o):
                continue
            keys = o.data.shape_keys.key_blocks
            for b in shapekeys:
                name = b["name"]
                mix = b["mix"]
                if keys.get(name) is not None:
                    keys.get(name).value = 0
                    o.shape_key_remove(keys.get(name))
                for m in mix:
                    if keys.get(m["name"]) is not None:
                        for k in keys:
                            k.value = 0
                        for m2 in mix:
                            kb = keys.get(m2["name"])
                            if kb is not None:
                                kb.value = m2["value"]
                        o.shape_key_add(name=name, from_mix=True)
                        for k in keys:
                            k.value = 0
                        count += 1
                        break
    log(f"  Created/verified {count} convenience extra shape keys")


# ---------------------------------------------------------------------------
# Material cleanup
# ---------------------------------------------------------------------------

def fix_materials():
    """Force opaque materials to OPAQUE blend mode and zero metallic."""
    log("Fixing material settings...")
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        # Reset metallic to avoid fully metallic look
        if mat.metallic > 0.5:
            mat.metallic = 0.0
        # For now, leave blend method as-is unless it is BLEND on an opaque material
        # This is conservative; user can tweak in Blender GUI if needed
    log("  Material cleanup done")


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def export_glb(output_path, target_objs):
    log(f"Exporting GLB to: {output_path}")
    output_path = str(Path(output_path).resolve())
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # Select only the target armature and target meshes for export
    bpy.ops.object.select_all(action="DESELECT")
    for obj in target_objs:
        if obj and obj.type in {"MESH", "ARMATURE"}:
            obj.select_set(True)

    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        use_selection=True,
        export_animations=False,
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_skins=True,
        export_all_influences=False,
        export_lights=False,
        export_cameras=False,
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
    )
    log("Export complete.")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Transfer TalkingHead rig + blendshapes to a custom mesh")
    parser.add_argument("--ref", required=True, help="Path to reference TalkingHead GLB")
    parser.add_argument("--target", required=True, help="Path to target static mesh GLB")
    parser.add_argument("--output", required=True, help="Output GLB path")
    parser.add_argument("--addon", required=True, help="Path to talkinghead-addon.py")
    parser.add_argument("--decimate-ratio", type=float, default=0.02,
                        help="Decimation ratio for the target mesh (0.0-1.0, default 0.02)")
    parser.add_argument("--target-yaw", type=float, default=0.0,
                        help="Yaw (deg around Z) to face the target toward Blender -Y / glTF +Z")
    parser.add_argument("--scale-mult", type=float, default=1.0,
                        help="Extra scale on top of the height match to align face regions "
                             "(ref eye height / target eye height after height match)")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])

    start_time = time.time()
    log_stage("START")
    log(f"Reference : {args.ref}")
    log(f"Target    : {args.target}")
    log(f"Output    : {args.output}")

    try:
        clear_scene()

        # Load TalkingHead addon helpers
        th_addon = load_talkinghead_addon(args.addon)

        # Stage: Import
        log_stage("IMPORT")
        ref_objs = import_glb(args.ref)
        target_objs = import_glb(args.target)

        ref_armature = find_armature(ref_objs)
        ref_meshes = find_meshes(ref_objs)
        ref_main = find_main_mesh(ref_meshes)

        # Strip any rig bundled with the target (e.g. Tripo "Animate" exports):
        # the reference armature replaces it for TalkingHead compatibility.
        target_armatures = [o for o in target_objs if o.type == "ARMATURE"]
        if target_armatures:
            for mesh in [o for o in target_objs if o.type == "MESH"]:
                for mod in list(mesh.modifiers):
                    if mod.type == "ARMATURE":
                        mesh.modifiers.remove(mod)
                anc = mesh.parent
                while anc is not None:
                    if anc in target_armatures:
                        mw = mesh.matrix_world.copy()
                        mesh.parent = None
                        mesh.matrix_world = mw
                        break
                    anc = anc.parent
                mesh.vertex_groups.clear()
            for arm in target_armatures:
                log(f"  Removing target's own armature: {arm.name}")
                target_objs.remove(arm)
                bpy.data.objects.remove(arm, do_unlink=True)

        target_meshes = find_meshes(target_objs)
        target_main = find_main_mesh(target_meshes)

        log_mesh_bbox("post-import", target_objs)

        # Stage: Decimate (heavy meshes need polygon reduction before rig transfer)
        log_stage("DECIMATE")
        for mesh in target_meshes:
            decimate_mesh(mesh, args.decimate_ratio)
        # Re-evaluate main mesh after decimation
        target_main = find_main_mesh(target_meshes)
        log_mesh_bbox("post-decimate", target_objs)

        log(f"Reference armature: {ref_armature.name}")
        log(f"Reference meshes: {len(ref_meshes)} (main: {ref_main.name})")
        log(f"Target meshes: {len(target_meshes)} (main: {target_main.name})")

        # Stage: Orient + Align
        log_stage("ALIGN")
        rotate_target_yaw(target_objs, args.target_yaw)
        align_target_to_reference(target_objs, ref_armature, args.scale_mult)

        # Stage: Armature transfer
        log_stage("ARMATURE TRANSFER")
        target_armature = transfer_armature(ref_armature, target_objs)
        strip_mixamorig_prefix(target_armature)
        # Re-apply transforms after potential name changes
        apply_all_transforms(target_armature)

        # Keep target armature together with target meshes for selection/export
        target_objs.append(target_armature)

        # Stage: Weight transfer
        log_stage("WEIGHT TRANSFER")
        for mesh in target_meshes:
            transfer_weights_data_transfer(mesh, ref_main, target_armature)
            add_armature_modifier(mesh, target_armature)
        log_mesh_bbox("post-weights", target_objs)

        # Stage: Shape key transfer
        log_stage("BLENDSHAPE TRANSFER")
        if ref_main.data.shape_keys and len(ref_main.data.shape_keys.key_blocks) > 1:
            transfer_shape_keys_surface_deform(target_main, ref_main, ref_objs)
        else:
            log("  WARNING: reference main mesh has no shape keys; skipping blendshape transfer")
        build_procedural_blink(target_main)

        # Sprite-mouth patch: separate mesh over the mouth, painted at
        # runtime with viseme-driven mouth shapes (cavity + teeth).
        overlay = build_mouth_overlay(target_main)
        if overlay is not None:
            target_objs.append(overlay)
            target_meshes.append(overlay)
        log_mesh_bbox("post-blendshapes", target_objs)

        # Remove reference objects so they are not exported or processed further
        delete_reference_objects(ref_objs)

        # Rename the duplicated armature to the exact name TalkingHead expects
        target_armature.name = "Armature"
        target_armature.data.name = "ArmatureData"

        # Stage: Post-process
        log_stage("POST-PROCESS")
        log("Scaling character (Hips -> z=1.0)...")
        set_active(target_armature)
        th_addon.scale_character([target_armature])
        log_mesh_bbox("post-scale-character", target_objs)

        log("Fixing bone axes (A-pose)...")
        set_active(target_armature)
        th_addon.fix_bone_axes([target_armature], th_addon.BONE_AXES_DATA_A)
        log_mesh_bbox("post-fix-bone-axes", target_objs)

        run_visemes_from_arkit()
        run_extras_from_arkit()
        fix_materials()

        # Apply all transforms one final time
        apply_all_transforms(target_armature)
        for mesh in target_meshes:
            apply_all_transforms(mesh)
        log_mesh_bbox("post-final-apply", target_objs)

        # The armature/Hips is on the world Z axis; make sure the mesh is too.
        recenter_mesh_horizontally(target_objs)

        # Stage: Export
        log_stage("EXPORT")
        remove_stray_objects(target_objs)
        export_glb(args.output, target_objs)

        elapsed = time.time() - start_time
        log_stage(f"DONE in {elapsed:.1f}s")
        log(f"Output written to: {args.output}")

    except Exception as e:
        log(f"FATAL ERROR: {e}")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
