"""Attempt automatic (bone-heat) weighting on the as-is asset and report whether
Blender can produce usable weights on this island-soup / non-manifold mesh."""
import bpy

SRC = r"C:\Users\sebas\Documents\projects\Manglara\scripts\avatar-rig-transfer\custom_avatar.pristine.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

arm = next(o for o in bpy.data.objects if o.type=="ARMATURE")
body = max((o for o in bpy.data.objects if o.type=="MESH"), key=lambda m: len(m.data.vertices))

# strip existing weights
for vg in list(body.vertex_groups):
    body.vertex_groups.remove(vg)

# select body then armature (active) and parent with automatic weights
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True); arm.select_set(True)
bpy.context.view_layer.objects.active = arm

err = None
try:
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
except Exception as e:
    err = str(e)

# report: how many verts got any weight, and arm vs body split
arm_names = {b.name for b in arm.data.bones if b.name.startswith(("LeftShoulder","LeftArm","LeftForeArm","LeftHand","RightShoulder","RightArm","RightForeArm","RightHand"))}
name_by_idx = {i:vg.name for i,vg in enumerate(body.vertex_groups)}
weighted = 0
for v in body.data.vertices:
    if len(v.groups) > 0 and sum(g.weight for g in v.groups) > 1e-4:
        weighted += 1
print(f"\n=== BONE-HEAT RESULT ===")
print(f"parent_set error: {err}")
print(f"vertex groups created: {len(body.vertex_groups)}")
print(f"verts with any weight: {weighted} / {len(body.data.vertices)}")
print("DONE")
