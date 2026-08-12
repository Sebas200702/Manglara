"""
Offline linear-blend-skinning simulator to quantify gesture-induced deformation
WITHOUT the browser. Poses the arm skeleton with the EXACT Euler rotations from
TalkingHead's gestureTemplates, skins the body mesh, and reports how far each
region moves. Run on the raw vs reweighted GLB to get a before/after on the
shoulder ballooning and the skirt drag.

Usage:  python sim_gesture_deform.py [glb1] [glb2 ...]
Default compares custom_avatar.glb (raw) vs custom_avatar.reweight.glb (capped).
"""
import sys
import numpy as np
import pygltflib

DEFAULT = ["web/public/custom_avatar.glb", "web/public/custom_avatar.reweight.glb"]

# Absolute LOCAL Euler rotations (rad) held during the gesture, from
# talkinghead.mjs gestureTemplates. Array props [from,to,...] -> use `to`.
GESTURES = {
    "index": {  # single left-arm point, arm raised high
        "LeftShoulder": (2.0, 0.4, -1.3),
        "LeftArm": (1.7, -0.4, 1.2),
        "LeftForeArm": (-0.815, 0.0, 1.575),
        "LeftHand": (-0.276, -0.506, -0.208),
    },
    "side": {  # gentle present, hand near hip (the calmest gesture)
        "LeftShoulder": (1.755, -0.035, -1.63),
        "LeftArm": (1.263, -0.955, 1.024),
        "LeftForeArm": (0.0, 0.0, 0.8),
        "LeftHand": (-0.36, -1.353, -0.184),
    },
}
ARM = ("LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
       "RightShoulder", "RightArm", "RightForeArm", "RightHand")


def euler_xyz(x, y, z):
    """Replicate THREE.Matrix4.makeRotationFromEuler order 'XYZ' exactly."""
    c1, s1 = np.cos(x), np.sin(x)
    c2, s2 = np.cos(y), np.sin(y)
    c3, s3 = np.cos(z), np.sin(z)
    ae, af, be, bf = c1 * c3, c1 * s3, s1 * c3, s1 * s3
    R = np.array([
        [c2 * c3,        -c2 * s3,        s2],
        [af + be * s2,   ae - bf * s2,   -s1 * c2],
        [bf - ae * s2,   be + af * s2,    c1 * c2],
    ])
    return R


def mat(data):  # gltf column-major 16 -> numpy 4x4
    return np.array(data, dtype=np.float64).reshape(4, 4).T


def acc(g, b, i):
    a = g.accessors[i]; bv = g.bufferViews[a.bufferView]
    comp = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a.componentType]
    nc = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a.type]
    s = (bv.byteOffset or 0) + (a.byteOffset or 0)
    return np.frombuffer(b, dtype=comp, count=a.count * nc, offset=s).reshape(a.count, nc)


def decompose(M):
    """M (4x4) -> (T[3], R3x3, S[3]) assuming T*R*S, no shear."""
    T = M[:3, 3].copy()
    C = M[:3, :3]
    S = np.linalg.norm(C, axis=0)
    S[S < 1e-12] = 1.0
    R = C / S
    return T, R, S


def local_rest(n):
    if n.matrix:
        return mat(n.matrix)
    T = np.eye(4); R = np.eye(4); Sc = np.eye(4)
    if n.translation:
        T[:3, 3] = n.translation
    if n.rotation:
        x, y, z, w = n.rotation
        R[:3, :3] = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    if n.scale:
        Sc[0, 0], Sc[1, 1], Sc[2, 2] = n.scale
    return T @ R @ Sc


def globals_from_locals(g, locals_):
    parent = {}
    for i, n in enumerate(g.nodes):
        for c in (n.children or []):
            parent[c] = i
    glob = {}

    def gm(i):
        if i in glob:
            return glob[i]
        glob[i] = locals_[i] if i not in parent else gm(parent[i]) @ locals_[i]
        return glob[i]
    for i in range(len(g.nodes)):
        gm(i)
    return glob


def skinned(pos, J, W, glob, ibm, joints):
    """World-space skinned positions for the given joint globals."""
    nv = len(pos)
    ph = np.concatenate([pos, np.ones((nv, 1))], axis=1)  # (nv,4)
    out = np.zeros((nv, 3))
    for k in range(J.shape[1]):
        wk = W[:, k]
        if wk.max() == 0:
            continue
        for slot in np.unique(J[:, k]):
            m = (J[:, k] == slot) & (wk > 0)
            if not m.any():
                continue
            M = glob[joints[slot]] @ ibm[slot]
            out[m] += (wk[m, None]) * (ph[m] @ M.T)[:, :3]
    return out


def analyze(path):
    g = pygltflib.GLTF2().load(path); b = g.binary_blob()
    skin = g.skins[0]
    jnames = [g.nodes[n].name for n in skin.joints]
    name2slot = {n: s for s, n in enumerate(jnames)}
    joints_nodes = list(skin.joints)
    ibm_raw = acc(g, b, skin.inverseBindMatrices)
    ibm = [mat(ibm_raw[k].tolist()) for k in range(len(joints_nodes))]

    prim = max((p for m in g.meshes for p in m.primitives
                if p.attributes.JOINTS_0 is not None),
               key=lambda p: g.accessors[p.attributes.POSITION].count)
    pos = acc(g, b, prim.attributes.POSITION).astype(np.float64)
    J = acc(g, b, prim.attributes.JOINTS_0).astype(np.int64)
    W = acc(g, b, prim.attributes.WEIGHTS_0).astype(np.float64)

    dom = J[np.arange(len(J)), np.argmax(W, 1)]
    dom_name = np.array([jnames[d] for d in dom])
    y = pos[:, 1]
    ylo, yhi = y.min(), y.max()
    waist = ylo + 0.45 * (yhi - ylo)

    left_arm = np.isin(dom_name, ["LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand"]) | \
        np.array([n.startswith("LeftHand") for n in dom_name])
    shoulder = dom_name == "LeftShoulder"
    skirt = (~np.isin(dom_name, list(ARM))) & (y < waist)

    rest_locals = [local_rest(n) for n in g.nodes]
    rest_glob = globals_from_locals(g, rest_locals)
    p_rest = skinned(pos, J, W, rest_glob, ibm, joints_nodes)

    print(f"\n### {path}")
    print(f"  verts={len(pos)}  y[{ylo:.2f},{yhi:.2f}] waist@{waist:.2f}  "
          f"leftArm={int(left_arm.sum())} shoulder={int(shoulder.sum())} skirt={int(skirt.sum())}")
    print(f"  rest-pose skinning error (should be ~0): max={np.linalg.norm(p_rest - pos, axis=1).max():.5f}")

    for gname, pose in GESTURES.items():
        locals_ = list(rest_locals)
        for bone, (ex, ey, ez) in pose.items():
            s = name2slot.get(bone)
            if s is None:
                continue
            ni = joints_nodes[s]
            T, _, S = decompose(rest_locals[ni])
            M = np.eye(4)
            M[:3, :3] = euler_xyz(ex, ey, ez) @ np.diag(S)
            M[:3, 3] = T
            locals_[ni] = M
        gl = globals_from_locals(g, locals_)
        p_pose = skinned(pos, J, W, gl, ibm, joints_nodes)
        disp = np.linalg.norm(p_pose - p_rest, axis=1)

        def stat(mask):
            d = disp[mask]
            if len(d) == 0:
                return "  n/a"
            return f"mean={d.mean()*100:5.2f} p95={np.percentile(d,95)*100:5.2f} max={d.max()*100:6.2f} std={d.std()*100:5.2f} (cm)"
        print(f"  [{gname:5}] leftArm  {stat(left_arm)}")
        print(f"  [{gname:5}] shoulder {stat(shoulder)}   <- balloon zone")
        print(f"  [{gname:5}] skirt    {stat(skirt)}   <- should stay ~0")


if __name__ == "__main__":
    for p in (sys.argv[1:] or DEFAULT):
        analyze(p)
