"""
Build a clean SKIN mask for the Manglara character and preview a darker skin
tone, WITHOUT re-running the rig transfer (morphs stay intact) and WITHOUT
touching the orange dress / afro / leaves / eyes.

Skin != dress by color (they overlap in hue), so we gate by GEOMETRY:
  1. Sample base-color texture per vertex; detect painted eyes -> head landmark.
  2. Rasterize a HEAD/neck REGION footprint into UV space (all faces in the
     z-band above the collar -> solid coverage incl. hair & eyes).
  3. Within that footprint, classify PIXELS: skin = warm tone, not dark afro,
     not white eye. Pixel-level (not per-vertex) -> smooth, no patchiness.
  4. Morphological CLOSE (dilate->erode) fills nostril/lip pinholes, then feather.
  5. Preview: darken the texture where mask>0 and render face before/after.
  6. Save mask.png -> the real GLB texture is patched by splice_texture.py
     (pure Python, keeps the JPEG + morphs byte-for-byte except the image).

Run:
  blender -b -noaudio -P darken_skin.py -- --glb <in> --darkness 0.35 \
      --mask-png renders/skin_mask.png --outdir renders
"""
import sys, os, argparse, math
import numpy as np
import bpy, mathutils

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import transfer_rig as T


def rgb_to_hsv_np(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1); mn = rgb.min(-1); d = mx - mn
    h = np.zeros_like(mx); m = d > 1e-6
    rm = m & (mx == r); gm = m & (mx == g) & ~rm; bm = m & (mx == b) & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = ((b - r)[gm] / d[gm]) + 2
    h[bm] = ((r - g)[bm] / d[bm]) + 4
    h *= 60.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0.0)
    return h, s, mx


def box_blur(a, r, passes=1):
    out = a.astype(np.float64)
    for _ in range(passes):
        for axis in (0, 1):
            n = out.shape[axis]
            c = np.cumsum(out, axis=axis)
            z = np.zeros_like(np.take(c, [0], axis=axis))
            c = np.concatenate([z, c], axis=axis)
            lo = np.clip(np.arange(n) - r, 0, n)
            hi = np.clip(np.arange(n) + r + 1, 0, n)
            num = np.take(c, hi, axis=axis) - np.take(c, lo, axis=axis)
            den = (hi - lo).reshape([-1 if i == axis else 1 for i in range(2)])
            out = num / den
    return out


def dilate(mask, r):
    return (box_blur(mask.astype(np.float64), r, 1) > 1e-6).astype(np.float64)


def erode(mask, r):
    return (box_blur(mask.astype(np.float64), r, 1) > 1 - 1e-6).astype(np.float64)


def find_tex_image(obj):
    image = None
    for slot in obj.material_slots:
        mat = slot.material
        if not mat or not mat.node_tree:
            continue
        for node in mat.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image and node.image.size[0] > 0:
                if image is None or node.image.size[0] > image.size[0]:
                    image = node.image
    return image


def add_camera(name, location, look_at, fov_deg):
    cd = bpy.data.cameras.new(name); cd.lens_unit = "FOV"; cd.angle = math.radians(fov_deg)
    cam = bpy.data.objects.new(name, cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = location
    d = mathutils.Vector(look_at) - mathutils.Vector(location)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return cam


def render(cam, outpath):
    sc = bpy.context.scene; sc.camera = cam
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "TEXTURE"
    sc.render.resolution_x = 640; sc.render.resolution_y = 640
    sc.render.film_transparent = False; sc.render.filepath = str(outpath)
    bpy.ops.render.render(write_still=True)
    print(f"[darken] wrote {outpath}", flush=True)


def rasterize_faces(tri_l, sel, all_uv, w, hpx):
    mask = np.zeros((hpx, w), dtype=np.float64)
    for i in sel:
        uv = all_uv[tri_l[i]]
        px = uv[:, 0] * (w - 1); py = uv[:, 1] * (hpx - 1)
        x0 = max(int(np.floor(px.min())), 0); x1 = min(int(np.ceil(px.max())), w - 1)
        y0 = max(int(np.floor(py.min())), 0); y1 = min(int(np.ceil(py.max())), hpx - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        x1_, y1_ = px[0], py[0]; x2_, y2_ = px[1], py[1]; x3_, y3_ = px[2], py[2]
        det = (y2_ - y3_) * (x1_ - x3_) + (x3_ - x2_) * (y1_ - y3_)
        if abs(det) < 1e-9:
            continue
        a = ((y2_ - y3_) * (xs - x3_) + (x3_ - x2_) * (ys - y3_)) / det
        b = ((y3_ - y1_) * (xs - x3_) + (x1_ - x3_) * (ys - y3_)) / det
        c = 1 - a - b
        inside = (a >= -0.01) & (b >= -0.01) & (c >= -0.01)
        mask[ys[inside], xs[inside]] = 1.0
    return mask


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    ap.add_argument("--darkness", type=float, default=0.35)
    ap.add_argument("--warmth", type=float, default=0.12)
    ap.add_argument("--feather", type=int, default=5)
    ap.add_argument("--close", type=int, default=6, help="morphological close radius px")
    ap.add_argument("--mask-png", default="")
    ap.add_argument("--outdir", default=os.path.join(HERE, "renders"))
    args = ap.parse_args(argv)
    os.makedirs(args.outdir, exist_ok=True)

    T.clear_scene()
    objs = T.import_glb(args.glb)
    body = max(T.find_meshes(objs), key=lambda o: len(o.data.vertices))
    me = body.data
    print(f"[darken] body={body.name!r} verts={len(me.vertices)}")

    co, rgb = T.sample_vertex_colors(body)
    z = co[:, 2]; zmin = z.min(); Hgt = z.max() - zmin
    eyes = T.detect_eye_centers(body)
    if eyes is None:
        eye_z = zmin + 0.85 * Hgt; eye_sep = 0.12 * Hgt
        print("[darken] WARN eye detect failed; bbox fallback")
    else:
        L, R = eyes
        eye_z = 0.5 * (L[2] + R[2]); eye_sep = float(np.linalg.norm(np.array(L) - np.array(R)))
    print(f"[darken] eye_z={eye_z:.3f} eye_sep={eye_sep:.3f}")

    # 1) head/neck region footprint (geometry only) -> solid UV coverage
    head_vert = z > (eye_z - 3.6 * eye_sep)
    img = find_tex_image(body)
    w, hpx = img.size
    me.calc_loop_triangles()
    tris = me.loop_triangles; n_tri = len(tris)
    tri_v = np.empty((n_tri, 3), dtype=np.int64)
    tri_l = np.empty((n_tri, 3), dtype=np.int64)
    for i, t in enumerate(tris):
        tri_v[i] = t.vertices; tri_l[i] = t.loops
    all_uv = np.empty((len(me.loops), 2), dtype=np.float64)
    me.uv_layers.active.data.foreach_get("uv", all_uv.reshape(-1))
    head_face = head_vert[tri_v].sum(1) >= 2
    region = rasterize_faces(tri_l, np.nonzero(head_face)[0], all_uv, w, hpx)
    region = dilate(region, 2)  # close raster cracks in the footprint
    print(f"[darken] head footprint px = {int(region.sum())}")

    # 2) pixel-level skin classification inside the footprint
    px = np.empty(w * hpx * 4, dtype=np.float32)
    img.pixels.foreach_get(px); px = px.reshape(hpx, w, 4)
    prgb = px[..., :3].astype(np.float64)
    ph, ps, pv = rgb_to_hsv_np(prgb)
    warm = (prgb[..., 0] > prgb[..., 1]) & (prgb[..., 1] >= prgb[..., 2] * 0.85) & (ph > 2) & (ph < 36)
    not_hair = pv > 0.20
    not_white = ~((prgb.min(-1) > 0.5) & ((prgb.max(-1) - prgb.min(-1)) < 0.35))
    skin_px = (region > 0.5) & warm & not_hair & not_white
    print(f"[darken] skin px raw = {int(skin_px.sum())}")

    # 3) morphological close to fill pinholes, then feather
    m = skin_px.astype(np.float64)
    m = erode(dilate(m, args.close), args.close)   # close
    m = m * (region > 0.5)                          # never leak outside head
    m = np.clip(box_blur(m, args.feather, 2), 0, 1) # feather
    print(f"[darken] mask coverage = {int((m>0.01).sum())} px")

    if args.mask_png:
        mimg = bpy.data.images.new("SkinMask", w, hpx)
        rgba = np.stack([m, m, m, np.ones_like(m)], -1).astype(np.float32)
        mimg.pixels.foreach_set(rgba.reshape(-1))
        mimg.filepath_raw = os.path.abspath(args.mask_png); mimg.file_format = "PNG"
        mimg.save()
        print(f"[darken] wrote mask -> {args.mask_png}")

    # 4) preview render before/after
    cam = add_camera("cam_face", (0, -0.62, eye_z - 0.02), (0, 0, eye_z - 0.06), 26)
    render(cam, os.path.join(args.outdir, "skin_before.png"))

    d = args.darkness
    gain = np.clip(np.array([1 - d, 1 - d - args.warmth, 1 - d - args.warmth * 1.4]), 0.05, 1.0)
    print(f"[darken] gain RGB = {gain}")
    out = px.copy()
    m3 = m[..., None]
    out[..., :3] = px[..., :3] * (1 - m3) + px[..., :3] * gain * m3
    new = bpy.data.images.new("SkinColorDark", w, hpx)
    new.pixels.foreach_set(out.reshape(-1)); new.pack()
    for slot in body.material_slots:
        mat = slot.material
        if mat and mat.node_tree:
            for node in mat.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image is img:
                    node.image = new
    render(cam, os.path.join(args.outdir, "skin_after.png"))


if __name__ == "__main__":
    main()
