"""
Headless analysis of the Manglara character texture to determine whether SKIN
texels can be separated from the orange DRESS before darkening skin tone.

Loads the rigged custom_avatar.glb, samples the base-color texture per vertex,
locates the head via the painted-eye landmarks, and reports color statistics
for head-region vs torso-region verts so we can pick a robust skin mask.

Run:
  "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" -b -noaudio \
      -P analyze_skin.py -- --glb <path>
"""
import sys, os, argparse
import numpy as np
import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import transfer_rig as T  # reuse import_glb / sample_vertex_colors / detect_eye_centers


def rgb_to_hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1); mn = rgb.min(-1); d = mx - mn
    h = np.zeros_like(mx)
    mask = d > 1e-6
    # hue
    rmax = mask & (mx == r)
    gmax = mask & (mx == g)
    bmax = mask & (mx == b)
    h[rmax] = ((g - b)[rmax] / d[rmax]) % 6
    h[gmax] = ((b - r)[gmax] / d[gmax]) + 2
    h[bmax] = ((r - g)[bmax] / d[bmax]) + 4
    h = h * 60.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    v = mx
    return np.stack([h, s, v], -1)


def summarize(tag, rgb):
    if len(rgb) == 0:
        print(f"  {tag}: (empty)")
        return
    hsv = rgb_to_hsv(rgb)
    print(f"  {tag}: n={len(rgb)}")
    print(f"     RGB mean=({rgb[:,0].mean():.3f},{rgb[:,1].mean():.3f},{rgb[:,2].mean():.3f})")
    print(f"     H  p10/50/90 = {np.percentile(hsv[:,0],10):.0f} / {np.percentile(hsv[:,0],50):.0f} / {np.percentile(hsv[:,0],90):.0f} deg")
    print(f"     S  p10/50/90 = {np.percentile(hsv[:,1],10):.2f} / {np.percentile(hsv[:,1],50):.2f} / {np.percentile(hsv[:,1],90):.2f}")
    print(f"     V  p10/50/90 = {np.percentile(hsv[:,2],10):.2f} / {np.percentile(hsv[:,2],50):.2f} / {np.percentile(hsv[:,2],90):.2f}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--glb", required=True)
    args = ap.parse_args(argv)

    T.clear_scene()
    objs = T.import_glb(args.glb)
    meshes = T.find_meshes(objs)
    # main body mesh = the one with the most verts (tripo body, not mouth overlay)
    body = max(meshes, key=lambda o: len(o.data.vertices))
    print(f"Body mesh: {body.name!r} verts={len(body.data.vertices)}")

    res = T.sample_vertex_colors(body)
    if res is None:
        print("No texture found"); return
    co, rgb = res
    z = co[:, 2]
    zmin, zmax = z.min(), z.max()
    H = zmax - zmin
    print(f"Bbox Z: {zmin:.3f}..{zmax:.3f} height={H:.3f}")

    eyes = T.detect_eye_centers(body)
    if eyes is None:
        print("WARN: eye detection failed; falling back to bbox fractions")
        eye_z = zmin + 0.85 * H
        eye_sep = 0.1 * H
    else:
        left, right = eyes
        eye_z = 0.5 * (left[2] + right[2])
        eye_sep = float(np.linalg.norm(np.array(left) - np.array(right)))
        print(f"Eyes: L={left} R={right}")
    print(f"eye_z={eye_z:.3f} eye_sep={eye_sep:.3f}")

    hsv = rgb_to_hsv(rgb)

    # region masks
    # head: from just below chin (eye_z - 2.5*eye_sep) upward
    chin_z = eye_z - 2.5 * eye_sep
    head = z > chin_z
    torso = (z <= chin_z) & (z > zmin + 0.30 * H)  # dress torso band
    print(f"\nchin_z~{chin_z:.3f}  head verts={head.sum()}  torso verts={torso.sum()}")

    # tone classes by simple rules
    warm = (rgb[:, 0] > rgb[:, 1]) & (rgb[:, 1] >= rgb[:, 2])  # R>=G>=B
    green = (rgb[:, 1] > rgb[:, 0]) & (rgb[:, 1] > rgb[:, 2])   # leaves
    dark = hsv[:, 2] < 0.18                                     # hair/shadow
    whiteish = (rgb.min(1) > 0.5) & ((rgb.max(1) - rgb.min(1)) < 0.35)

    print("\n== HEAD region ==")
    summarize("head-warm (skin?)", rgb[head & warm & ~dark & ~whiteish])
    summarize("head-dark (hair?)", rgb[head & dark])
    print("\n== TORSO region ==")
    summarize("torso-warm (dress?)", rgb[torso & warm & ~dark])
    summarize("torso-green (leaves)", rgb[torso & green])

    # How separable are head-warm vs torso-warm in HSV?
    print("\nSeparability check (skin vs dress, warm only):")
    summarize("SKIN cand (head warm)", rgb[head & warm & ~dark & ~whiteish])
    summarize("DRESS cand (torso warm)", rgb[torso & warm & ~dark])


if __name__ == "__main__":
    main()
