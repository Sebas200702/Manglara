"""Dump mesh bounds and world positions of key bones from a GLB.

Usage: python inspect_dimensions.py <path.glb> [ref.glb]
"""
import json
import struct
import sys


def load_gltf(path):
    with open(path, 'rb') as f:
        data = f.read()
    length = struct.unpack('<I', data[8:12])[0]
    chunk_offset = 12
    gltf = None
    while chunk_offset < length:
        chunk_len = struct.unpack('<I', data[chunk_offset:chunk_offset+4])[0]
        chunk_type = struct.unpack('<I', data[chunk_offset+4:chunk_offset+8])[0]
        chunk_data = data[chunk_offset+8:chunk_offset+8+chunk_len]
        if chunk_type == 0x4E4F534A:  # JSON
            gltf = json.loads(chunk_data.decode('utf-8'))
            break
        chunk_offset += 8 + chunk_len
    return gltf


def mat_from_trs(t, r, s):
    """Compose a 4x4 (column-major nested lists) from translation/quat/scale."""
    x, y, z, w = r
    # rotation matrix from quaternion
    m = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    out = [[m[i][j] * s[j] for j in range(3)] + [t[i]] for i in range(3)]
    out.append([0, 0, 0, 1])
    return out


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def node_local(node):
    if 'matrix' in node:
        m = node['matrix']  # column-major flat
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = node.get('translation', [0, 0, 0])
    r = node.get('rotation', [0, 0, 0, 1])
    s = node.get('scale', [1, 1, 1])
    return mat_from_trs(t, r, s)


def world_positions(gltf):
    nodes = gltf['nodes']
    ident = [[1 if i == j else 0 for j in range(4)] for i in range(4)]
    world = {}

    def walk(idx, parent):
        m = mat_mul(parent, node_local(nodes[idx]))
        world[idx] = m
        for c in nodes[idx].get('children', []):
            walk(c, m)

    for scene in gltf.get('scenes', []):
        for root in scene.get('nodes', []):
            walk(root, ident)
    return world


def inspect(path):
    print(f"\n=== {path} ===")
    gltf = load_gltf(path)
    nodes = gltf['nodes']
    world = world_positions(gltf)

    interesting = {'Hips', 'Head', 'Neck', 'LeftEye', 'RightEye', 'HeadTop_End'}
    for idx, node in enumerate(nodes):
        name = node.get('name', '')
        if name in interesting and idx in world:
            m = world[idx]
            print(f"  bone {name:12s} world pos = ({m[0][3]:8.4f}, {m[1][3]:8.4f}, {m[2][3]:8.4f})")

    # Mesh bounds from POSITION accessors, transformed by mesh node world matrix
    for idx, node in enumerate(nodes):
        if 'mesh' not in node:
            continue
        mesh = gltf['meshes'][node['mesh']]
        m = world.get(idx)
        for prim in mesh.get('primitives', []):
            acc = gltf['accessors'][prim['attributes']['POSITION']]
            lo, hi = acc.get('min'), acc.get('max')
            print(f"  mesh node '{node.get('name','?')}' local POSITION min={['%.3f' % v for v in lo]} max={['%.3f' % v for v in hi]}")
            if m:
                sx = (m[0][0] ** 2 + m[1][0] ** 2 + m[2][0] ** 2) ** 0.5
                sy = (m[0][1] ** 2 + m[1][1] ** 2 + m[2][1] ** 2) ** 0.5
                sz = (m[0][2] ** 2 + m[1][2] ** 2 + m[2][2] ** 2) ** 0.5
                print(f"    node world scale approx = ({sx:.4f}, {sy:.4f}, {sz:.4f})")
                h = (hi[1] - lo[1]) * sy
                print(f"    approx world height (Y extent * scaleY) = {h:.4f}")

    # skeleton root scales
    for idx, node in enumerate(nodes):
        name = node.get('name', '')
        if name in ('Armature', 'Hips') and 'scale' in node:
            print(f"  node '{name}' local scale = {node['scale']}")


for p in sys.argv[1:]:
    inspect(p)
