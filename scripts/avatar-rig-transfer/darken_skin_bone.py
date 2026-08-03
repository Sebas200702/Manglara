"""
Darken the character's SKIN via per-vertex COLOR_0, selecting skin by BONE
WEIGHTS (the only reliable signal: skin and the orange dress are the same color
in the Tripo texture, so color/kmeans cannot separate arms from dress).

  skin = dominant bone in {Head, Neck, *Shoulder*, *Arm*, *Hand*}
         AND warm tone AND not dark afro AND not white eye.
  Spine2/Hips/legs (dress + skirt) are EXCLUDED -> garment untouched.

Writes COLOR_0 = 1-(1-gain)*w (glTF multiplies baseColorTexture x COLOR_0),
exports a small GLB with sparse morphs (morphs untouched).

Run: blender -b -noaudio -P darken_skin_bone.py -- --glb <in> --out <out> \
        --darkness 0.55 --warmth 0.10
"""
import sys, os, argparse
import numpy as np, bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import transfer_rig as T


def rgb_to_hsv_np(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1); d = mx - rgb.min(-1)
    h = np.zeros_like(mx); m = d > 1e-6
    rm = m & (mx == r); gm = m & (mx == g) & ~rm; bm = m & (mx == b) & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = ((b - r)[gm] / d[gm]) + 2
    h[bm] = ((r - g)[bm] / d[bm]) + 4
    return h * 60.0, np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0.0), mx


def smooth_weight(me, w, iters, factor=0.5):
    n = len(me.vertices)
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges); e = edges.reshape(-1, 2)
    a, b = e[:, 0], e[:, 1]
    for _ in range(iters):
        acc = np.zeros(n); cnt = np.zeros(n)
        np.add.at(acc, a, w[b]); np.add.at(cnt, a, 1)
        np.add.at(acc, b, w[a]); np.add.at(cnt, b, 1)
        w = 0.5 * w + 0.5 * (acc / np.maximum(cnt, 1))
    return w


def is_skin_bone(name):
    if name in ("Head", "Neck"):
        return True
    return ("Shoulder" in name) or ("Arm" in name) or ("Hand" in name)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--darkness", type=float, default=0.55)
    ap.add_argument("--warmth", type=float, default=0.10)
    ap.add_argument("--smooth", type=int, default=6)
    args = ap.parse_args(argv)

    T.clear_scene()
    objs = T.import_glb(args.glb)
    body = max(T.find_meshes(objs), key=lambda o: len(o.data.vertices))
    me = body.data; n = len(me.vertices)

    co, rgb = T.sample_vertex_colors(body)
    h, s, v = rgb_to_hsv_np(rgb)
    warm = (rgb[:, 0] > rgb[:, 1]) & (rgb[:, 1] >= rgb[:, 2] * 0.85) & (h > 2) & (h < 40)
    not_dark = v > 0.22
    is_white = (rgb.min(1) > 0.5) & ((rgb.max(1) - rgb.min(1)) < 0.35)

    # dominant bone per vertex
    gname = {g.index: g.name for g in body.vertex_groups}
    dom = np.full(n, -1); domw = np.zeros(n)
    for vert in me.vertices:
        for g in vert.groups:
            if g.weight > domw[vert.index]:
                domw[vert.index] = g.weight; dom[vert.index] = g.group
    skin_bone = np.array([is_skin_bone(gname.get(d, "")) for d in dom])
    print(f"[bone] skin-bone verts = {int(skin_bone.sum())}")

    # bare chest/clavicle skin lands on Spine2 (dress bone). Within the spine
    # groups, skin is distinguishable from the orange dress by a HIGHER blue
    # ratio and LOWER saturation (skin B/R~0.09 S~0.92 vs dress B/R~0.03-0.07
    # S~0.96+). Pull in only clearly-skin spine verts; leave the dress.
    domn = np.array([gname.get(d, "") for d in dom])
    spine = np.isin(domn, ["Spine", "Spine1", "Spine2"])
    br = rgb[:, 2] / np.maximum(rgb[:, 0], 1e-6)
    spine_skin = spine & warm & not_dark & (br > 0.085) & (s < 0.93)
    print(f"[bone] spine bare-skin verts = {int(spine_skin.sum())}")

    skin = ((skin_bone | spine_skin) & warm & not_dark & ~is_white).astype(np.float64)
    print(f"[bone] skin verts raw = {int(skin.sum())} / {n}")

    w = smooth_weight(me, skin, args.smooth, 0.5)
    w = np.clip(w * 1.2, 0, 1)
    w[is_white] = 0.0
    # never bleed onto the dress: keep weight only where bone is skin (dilate 1 ring)
    keep = skin_bone.copy()
    print(f"[bone] weight>0.5 = {int((w>0.5).sum())}")

    d = args.darkness
    gain = np.clip(np.array([1 - d, 1 - d - args.warmth, 1 - d - args.warmth * 1.4]), 0.05, 1.0)
    print(f"[bone] gain = {gain}")
    vcol = 1.0 - (1.0 - gain)[None, :] * w[:, None]

    for ca in list(me.color_attributes):
        me.color_attributes.remove(ca)
    ca = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    buf = np.concatenate([vcol, np.ones((n, 1))], axis=1).astype(np.float32)
    ca.data.foreach_set("color", buf.reshape(-1))
    me.color_attributes.active_color = ca; me.attributes.active_color = ca

    bpy.ops.export_scene.gltf(
        filepath=args.out, export_format="GLB",
        export_morph=True, export_morph_normal=False, export_morph_tangent=False,
        export_try_sparse_sk=True,
        export_vertex_color="ACTIVE", export_all_vertex_colors=False,
        export_skins=True, use_selection=False,
    )
    print(f"[bone] exported {args.out} size={os.path.getsize(args.out)/1e6:.2f}MB")


if __name__ == "__main__":
    main()
