"""Blender diagnostic for the custom avatar: mesh health + rig/mesh alignment.

Run: blender --background --python bl_diagnose.py
Reports whether bone-heat can plausibly work (bones inside the mesh limbs?) and
whether the mesh is clean enough to auto-weight (manifold? interior geometry?).
"""
import bpy
import bmesh
from mathutils import Vector

SRC = r"C:\Users\sebas\Documents\projects\Manglara\scripts\avatar-rig-transfer\custom_avatar.pristine.glb"

# fresh scene
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
body = max(meshes, key=lambda m: len(m.data.vertices))
print(f"\n=== OBJECTS === armature={arm.name if arm else None}  "
      f"meshes={[ (m.name, len(m.data.vertices)) for m in meshes]}")
print(f"body = {body.name}  verts={len(body.data.vertices)}")

# mesh world-space bounds
me = body.data
mw = body.matrix_world
xs = [ (mw @ v.co).x for v in me.vertices ]
ys = [ (mw @ v.co).y for v in me.vertices ]
zs = [ (mw @ v.co).z for v in me.vertices ]
print(f"mesh bounds  x[{min(xs):.3f},{max(xs):.3f}]  y[{min(ys):.3f},{max(ys):.3f}]  z[{min(zs):.3f},{max(zs):.3f}]")

# mesh health via bmesh
bm = bmesh.new(); bm.from_mesh(me)
non_manifold_e = sum(1 for e in bm.edges if not e.is_manifold)
loose_v = sum(1 for v in bm.verts if not v.link_edges)
print(f"edges={len(bm.edges)} non_manifold_edges={non_manifold_e}  "
      f"faces={len(bm.faces)}  loose_verts={loose_v}")
# doubles estimate
bm.free()

# arm bone rest positions (armature space -> world), compare to mesh bounds
if arm:
    amw = arm.matrix_world
    print("\n=== ARM BONE REST (world) vs mesh x-halfwidth ===")
    xhw = max(abs(min(xs)), abs(max(xs)))
    print(f"mesh |x| half-width ~ {xhw:.3f}")
    for bn in ["LeftShoulder","LeftArm","LeftForeArm","LeftHand",
               "RightShoulder","RightArm","RightForeArm","RightHand"]:
        b = arm.data.bones.get(bn)
        if not b:
            print(f"  {bn}: MISSING"); continue
        h = amw @ b.head_local; t = amw @ b.tail_local
        inside = "INSIDE" if abs(h.x) <= xhw and abs(t.x) <= xhw else "OUTSIDE-mesh"
        print(f"  {bn:14s} head=({h.x:.3f},{h.y:.3f},{h.z:.3f}) tail=({t.x:.3f},{t.y:.3f},{t.z:.3f})  {inside}")

print("\n=== UP AXIS CHECK === (glTF Y-up; Blender Z-up import may rotate)")
print(f"armature world matrix:\n{arm.matrix_world if arm else None}")
print("DONE")
