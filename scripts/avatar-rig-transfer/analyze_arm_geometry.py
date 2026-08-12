"""
Characterize the arm geometry so we can re-weight it onto the arm bones.
The arm EXISTS but is painted to LeftShoulder/RightShoulder + Spine2 instead of
LeftArm/ForeArm/Hand. This measures where the arm bones sit in mesh space and how
separable the arm verts are from the torso/dress by distance to the bone chain.
"""
import numpy as np
import pygltflib

SRC = "web/public/custom_avatar.glb"

CHAIN_L = ["LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand"]
CHAIN_R = ["RightShoulder", "RightArm", "RightForeArm", "RightHand"]


def mat(d):
    return np.array(d, dtype=np.float64).reshape(4, 4).T


def acc(g, b, i):
    a = g.accessors[i]; bv = g.bufferViews[a.bufferView]
    comp = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a.componentType]
    nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a.type]
    s = (bv.byteOffset or 0) + (a.byteOffset or 0)
    return np.frombuffer(b, dtype=comp, count=a.count * nc, offset=s).reshape(a.count, nc)


def local(n):
    if n.matrix:
        return mat(n.matrix)
    T = np.eye(4); R = np.eye(4); S = np.eye(4)
    if n.translation:
        T[:3, 3] = n.translation
    if n.rotation:
        x, y, z, w = n.rotation
        R[:3, :3] = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    if n.scale:
        S[0, 0], S[1, 1], S[2, 2] = n.scale
    return T @ R @ S


def globals_(g):
    parent = {}
    for i, n in enumerate(g.nodes):
        for c in (n.children or []):
            parent[c] = i
    loc = [local(n) for n in g.nodes]
    glob = {}

    def gm(i):
        if i in glob:
            return glob[i]
        glob[i] = loc[i] if i not in parent else gm(parent[i]) @ loc[i]
        return glob[i]
    for i in range(len(g.nodes)):
        gm(i)
    return glob


def seg_dist(P, a, b):
    """Distance from points P (n,3) to segment a-b."""
    ab = b - a
    t = np.clip(((P - a) @ ab) / (ab @ ab + 1e-12), 0, 1)
    proj = a + t[:, None] * ab
    return np.linalg.norm(P - proj, axis=1), t


def main():
    g = pygltflib.GLTF2().load(SRC); b = g.binary_blob()
    skin = g.skins[0]
    jn = [g.nodes[n].name for n in skin.joints]
    glob = globals_(g)
    mesh_node = next(i for i, n in enumerate(g.nodes) if n.mesh is not None and n.skin is not None)
    meshGinv = np.linalg.inv(glob[mesh_node])

    def bone_pos(name):
        s = jn.index(name)
        node = skin.joints[s]
        return (meshGinv @ glob[node])[:3, 3]

    print("=== arm bone positions in mesh-local space (same frame as POSITION) ===")
    for nm in CHAIN_L + CHAIN_R:
        p = bone_pos(nm)
        print(f"  {nm:14s} ({p[0]:6.3f}, {p[1]:6.3f}, {p[2]:6.3f})")

    prim = max((p for m in g.meshes for p in m.primitives if p.attributes.JOINTS_0 is not None),
               key=lambda p: g.accessors[p.attributes.POSITION].count)
    pos = acc(g, b, prim.attributes.POSITION).astype(np.float64)
    J = acc(g, b, prim.attributes.JOINTS_0); W = acc(g, b, prim.attributes.WEIGHTS_0).astype(np.float64)
    dom = np.array([jn[d] for d in J[np.arange(len(J)), np.argmax(W, 1)]])

    # distance of every vertex to the LEFT lower-arm chain (Arm->ForeArm->Hand)
    la, lf, lh = bone_pos("LeftArm"), bone_pos("LeftForeArm"), bone_pos("LeftHand")
    d1, _ = seg_dist(pos, la, lf)
    d2, _ = seg_dist(pos, lf, lh)
    darm_L = np.minimum(d1, d2)

    left_sh = dom == "LeftShoulder"
    print(f"\n=== LeftShoulder-dominant verts: {int(left_sh.sum())} ===")
    print("distance to left lower-arm chain (m):")
    dd = darm_L[left_sh]
    for thr in (0.03, 0.05, 0.08, 0.12):
        print(f"  within {thr:.2f}m of arm chain: {int((dd < thr).sum()):5d}  ({100*(dd<thr).mean():4.1f}%)")
    print(f"  min={dd.min():.3f} median={np.median(dd):.3f} max={dd.max():.3f}")

    # how close are the ARM verts to the nearest DRESS vert (weld risk near hip)?
    arm_verts = left_sh & (darm_L < 0.06)
    print(f"\narm verts (LeftShoulder-dom & <0.06m to chain): {int(arm_verts.sum())}")
    print(f"  their y-range: [{pos[arm_verts,1].min():.2f}, {pos[arm_verts,1].max():.2f}]  "
          f"x-range: [{pos[arm_verts,0].min():.2f}, {pos[arm_verts,0].max():.2f}]")


if __name__ == "__main__":
    main()
