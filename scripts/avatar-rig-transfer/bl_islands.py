"""Count mesh islands (linked components) and classify by region, to learn
whether the arms/hands are separable from the dress or welded into one piece."""
import bpy, bmesh
from mathutils import Vector

SRC = r"C:\Users\sebas\Documents\projects\Manglara\scripts\avatar-rig-transfer\custom_avatar.pristine.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
body = max((o for o in bpy.data.objects if o.type=="MESH"), key=lambda m: len(m.data.vertices))

bm = bmesh.new(); bm.from_mesh(body.data); bm.verts.ensure_lookup_table()

# union-find over edges to get linked components
parent = list(range(len(bm.verts)))
def find(a):
    while parent[a]!=a:
        parent[a]=parent[parent[a]]; a=parent[a]
    return a
def union(a,b):
    ra,rb=find(a),find(b)
    if ra!=rb: parent[ra]=rb
for e in bm.edges:
    union(e.verts[0].index, e.verts[1].index)

from collections import defaultdict
comp = defaultdict(list)
for v in bm.verts:
    comp[find(v.index)].append(v.index)

comps = sorted(comp.values(), key=len, reverse=True)
print(f"\n=== {len(comps)} islands (top 15 by size) ===")
for c in comps[:15]:
    xs=[bm.verts[i].co.x for i in c]; ys=[bm.verts[i].co.y for i in c]; zs=[bm.verts[i].co.z for i in c]
    cx=sum(xs)/len(xs); cz=sum(zs)/len(zs)
    print(f"  n={len(c):6d}  x[{min(xs):.2f},{max(xs):.2f}] z[{min(zs):.2f},{max(zs):.2f}]  center(x={cx:.2f},z={cz:.2f})")
print(f"islands with >100 verts: {sum(1 for c in comps if len(c)>100)}")
bm.free()
print("DONE")
