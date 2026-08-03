import json
import struct
import sys

path = sys.argv[1]
with open(path, 'rb') as f:
    data = f.read()

magic = data[:4]
version = struct.unpack('<I', data[4:8])[0]
length = struct.unpack('<I', data[8:12])[0]
print(f"Magic: {magic}, version: {version}, length: {length}")

chunk_offset = 12
while chunk_offset < length:
    chunk_len = struct.unpack('<I', data[chunk_offset:chunk_offset+4])[0]
    chunk_type = struct.unpack('<I', data[chunk_offset+4:chunk_offset+8])[0]
    chunk_data = data[chunk_offset+8:chunk_offset+8+chunk_len]
    if chunk_type == 0x4E4F534A:  # JSON
        gltf = json.loads(chunk_data.decode('utf-8'))
        break
    chunk_offset += 8 + chunk_len

meshes = gltf.get('meshes', [])
print(f"Meshes: {len(meshes)}")
for i, mesh in enumerate(meshes):
    print(f"\nMesh {i}: {mesh.get('name', 'unnamed')}")
    for j, prim in enumerate(mesh.get('primitives', [])):
        print(f"  Primitive {j}:")
        targets = prim.get('targets', [])
        print(f"    targets count: {len(targets)}")
        prim_extras = prim.get('extras', {})
        prim_target_names = prim_extras.get('targetNames', [])
        mesh_extras = mesh.get('extras', {})
        mesh_target_names = mesh_extras.get('targetNames', [])
        print(f"    primitive targetNames count: {len(prim_target_names)}")
        print(f"    mesh targetNames count: {len(mesh_target_names)}")
        target_names = prim_target_names or mesh_target_names
        if target_names:
            print(f"    first 10: {target_names[:10]}")
            print(f"    has jawOpen: {'jawOpen' in target_names}")
            print(f"    has viseme_aa: {'viseme_aa' in target_names}")

nodes = gltf.get('nodes', [])
print(f"\nNodes: {len(nodes)}")
for i, node in enumerate(nodes):
    if 'skin' in node or 'mesh' in node:
        print(f"  Node {i}: {node.get('name', 'unnamed')} mesh={node.get('mesh')} skin={node.get('skin')}")

skins = gltf.get('skins', [])
print(f"\nSkins: {len(skins)}")
for i, skin in enumerate(skins):
    print(f"  Skin {i}: {skin.get('name', 'unnamed')} joints={len(skin.get('joints', []))}")

scenes = gltf.get('scenes', [])
for scene in scenes:
    print(f"\nScene nodes: {scene.get('nodes', [])}")
