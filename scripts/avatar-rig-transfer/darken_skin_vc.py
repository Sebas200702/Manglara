"""
Darken the Manglara character's SKIN via a per-vertex COLOR_0 layer (glTF
multiplies baseColorTexture x vertexColor), so we NEVER touch the chaotic Tripo
UV atlas and get smooth, patch-free shading. The dress / afro / leaves / eyes
keep vertex color white (1,1,1) => unchanged.

  1. Sample base-color texture per vertex; detect painted eyes -> head landmark.
  2. skin vert = HEAD/neck region AND warm skin tone AND not dark afro AND
     not white eye.  (Geometry gates out the same-hue orange dress.)
  3. Smooth the 0/1 skin weight over mesh topology -> soft edges.
  4. Write COLOR_0 = 1 - (1-gain)*weight per channel; export a fresh GLB with
     SPARSE morph accessors so the file stays small and morphs stay intact.

Run:
  blender -b -noaudio -P darken_skin_vc.py -- --glb <in> --out <out> \
      --darkness 0.35 --warmth 0.12 --outdir renders
"""
import sys, os, argparse, math
import numpy as np
import bpy, mathutils

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


def add_camera(name, location, look_at, fov_deg):
    cd = bpy.data.cameras.new(name); cd.lens_unit = "FOV"; cd.angle = math.radians(fov_deg)
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = location
    dd = mathutils.Vector(look_at) - mathutils.Vector(location)
    cam.rotation_euler = dd.to_track_quat("-Z", "Y").to_euler()
    return cam


def render(cam, outpath, color_type="TEXTURE"):
    sc = bpy.context.scene; sc.camera = cam
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = color_type
    sc.render.resolution_x = 640; sc.render.resolution_y = 640
    sc.render.film_transparent = False; sc.render.filepath = str(outpath)
    bpy.ops.render.render(write_still=True)
    print(f"[vc] wrote {outpath}", flush=True)


def smooth_weight(me, w, iters, factor=0.5):
    n = len(me.vertices)
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    e = edges.reshape(-1, 2)
    a, b = e[:, 0], e[:, 1]
    for _ in range(iters):
        acc = np.zeros(n); cnt = np.zeros(n)
        np.add.at(acc, a, w[b]); np.add.at(cnt, a, 1)
        np.add.at(acc, b, w[a]); np.add.at(cnt, b, 1)
        nb = acc / np.maximum(cnt, 1)
        w = (1 - factor) * w + factor * nb
    return w


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--darkness", type=float, default=0.35)
    ap.add_argument("--warmth", type=float, default=0.12)
    ap.add_argument("--smooth", type=int, default=8)
    ap.add_argument("--outdir", default=os.path.join(HERE, "renders"))
    ap.add_argument("--no-render", action="store_true")
    args = ap.parse_args(argv)
    os.makedirs(args.outdir, exist_ok=True)

    T.clear_scene()
    objs = T.import_glb(args.glb)
    body = max(T.find_meshes(objs), key=lambda o: len(o.data.vertices))
    me = body.data
    n = len(me.vertices)
    print(f"[vc] body={body.name!r} verts={n}")

    co, rgb = T.sample_vertex_colors(body)
    z = co[:, 2]; zmin = z.min(); Hgt = z.max() - zmin
    eyes = T.detect_eye_centers(body)
    if eyes is None:
        eye_z = zmin + 0.85 * Hgt; eye_sep = 0.12 * Hgt
        print("[vc] WARN eye detect failed; bbox fallback")
    else:
        L, R = eyes
        eye_z = 0.5 * (L[2] + R[2]); eye_sep = float(np.linalg.norm(np.array(L) - np.array(R)))
    print(f"[vc] eye_z={eye_z:.3f} eye_sep={eye_sep:.3f}")

    h, s, v = rgb_to_hsv_np(rgb)
    warm = (rgb[:, 0] > rgb[:, 1]) & (rgb[:, 1] >= rgb[:, 2] * 0.85) & (h > 2) & (h < 36)
    not_hair = v > 0.20
    not_white = ~((rgb.min(1) > 0.5) & ((rgb.max(1) - rgb.min(1)) < 0.35))
    head = z > (eye_z - 3.6 * eye_sep)
    skin = (head & warm & not_hair & not_white).astype(np.float64)
    print(f"[vc] skin verts raw = {int(skin.sum())} / {n}")

    w = smooth_weight(me, skin, args.smooth, 0.5)
    # renormalize: keep strong interior, soften only edges
    w = np.clip(w * 1.15, 0, 1)
    # never darken painted eye-whites (smoothing can bleed onto them)
    is_white = (rgb.min(1) > 0.5) & ((rgb.max(1) - rgb.min(1)) < 0.35)
    w[is_white] = 0.0
    print(f"[vc] weight mean={w.mean():.3f} max={w.max():.3f} (>0.5)={int((w>0.5).sum())}")

    d = args.darkness
    gain = np.clip(np.array([1 - d, 1 - d - args.warmth, 1 - d - args.warmth * 1.4]), 0.05, 1.0)
    print(f"[vc] gain RGB = {gain}")
    vcol = 1.0 - (1.0 - gain)[None, :] * w[:, None]   # (n,3), white where w=0

    # write COLOR_0 (float color, POINT domain)
    for ca in list(me.color_attributes):
        me.color_attributes.remove(ca)
    ca = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    buf = np.concatenate([vcol, np.ones((n, 1))], axis=1).astype(np.float32)
    ca.data.foreach_set("color", buf.reshape(-1))
    me.color_attributes.active_color = ca
    me.attributes.active_color = ca

    if not args.no_render:
        cam = add_camera("cam_face", (0, -0.62, eye_z - 0.02), (0, 0, eye_z - 0.06), 26)
        # BEFORE: texture only
        render(cam, os.path.join(args.outdir, "vc_before.png"), "TEXTURE")

    bpy.ops.export_scene.gltf(
        filepath=args.out, export_format="GLB",
        export_morph=True, export_morph_normal=False, export_morph_tangent=False,
        export_try_sparse_sk=True,
        export_vertex_color="ACTIVE", export_all_vertex_colors=False,
        export_skins=True, use_selection=False,
    )
    sz = os.path.getsize(args.out)
    print(f"[vc] exported {args.out} size={sz/1e6:.2f}MB")


if __name__ == "__main__":
    main()
