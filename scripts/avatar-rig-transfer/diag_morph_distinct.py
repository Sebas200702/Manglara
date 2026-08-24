"""Are the visemes actually DIFFERENT shapes? Pairwise similarity + mouth metrics.

Two failure modes this catches that a name/target-count check cannot:
 - duplicate shape keys (viseme_X copied to viseme_Y) -> mushy, repetitive lipsync
 - visemes that move geometry away from the lips (bad transfer) -> no readable mouth

Usage: python diag_morph_distinct.py <file.glb> [mesh] [prim_index]
"""
import sys
from pathlib import Path

from diag_morphs import load, read_accessor

VISEMES = ["viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD",
           "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR",
           "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
           "jawOpen", "mouthOpen"]


def main(path, mesh_name=None, prim_i=None):
    g, blob = load(path)
    mesh = next(m for m in g["meshes"]
                if (mesh_name is None and m["primitives"][0].get("targets"))
                or m.get("name") == mesh_name)
    tnames = (mesh.get("extras") or {}).get("targetNames") or []
    # default: the primitive with the most vertices (the skin)
    if prim_i is None:
        prim_i = max(range(len(mesh["primitives"])),
                     key=lambda i: g["accessors"][mesh["primitives"][i]
                                                  ["attributes"]["POSITION"]]["count"])
    p = mesh["primitives"][prim_i]
    print(f"mesh '{mesh.get('name')}' prim[{prim_i}] "
          f"mat={g['materials'][p['material']].get('name') if 'material' in p else None}")

    base = read_accessor(g, blob, p["attributes"]["POSITION"])
    # mouth region = lowest-front part of the head: take verts in the front half
    # of the head bbox, below the eyes.
    ys = [v[1] for v in base]
    top = max(ys)
    head_lo = top - 0.28 * (top - min(ys))  # crude head band for a full body mesh
    zs = [v[2] for v in base if v[1] > head_lo]
    zfront = max(zs) - 0.35 * (max(zs) - min(zs))
    mouth_idx = [i for i, v in enumerate(base)
                 if v[1] > head_lo and v[2] > zfront]
    print(f"  head band y>{head_lo:.3f}, front z>{zfront:.3f} -> "
          f"{len(mouth_idx)} candidate face verts of {len(base)}")

    deltas = {}
    for name in VISEMES:
        if name not in tnames:
            print(f"  !! missing target '{name}'")
            continue
        ti = tnames.index(name)
        t = p["targets"][ti]
        d = read_accessor(g, blob, t["POSITION"])
        deltas[name] = d

    print("\n  per-viseme mouth metrics (only face-region verts counted):")
    print(f"  {'name':<12} {'|d| in face':>11} {'|d| elsewhere':>14} "
          f"{'dY down':>8} {'dY up':>8} {'dX spread':>10}")
    for name, d in deltas.items():
        face = sum((d[i][0] ** 2 + d[i][1] ** 2 + d[i][2] ** 2) ** 0.5
                   for i in mouth_idx)
        allsum = sum((v[0] ** 2 + v[1] ** 2 + v[2] ** 2) ** 0.5 for v in d)
        dy_dn = min((d[i][1] for i in mouth_idx), default=0)
        dy_up = max((d[i][1] for i in mouth_idx), default=0)
        dx = max((abs(d[i][0]) for i in mouth_idx), default=0)
        print(f"  {name:<12} {face:>11.4f} {allsum - face:>14.4f} "
              f"{dy_dn:>8.4f} {dy_up:>8.4f} {dx:>10.4f}")

    names = list(deltas)
    print("\n  pairwise cosine similarity (1.00 = identical shape):")
    hdr = "".join(f"{n.replace('viseme_', ''):>7}" for n in names)
    print(f"  {'':<12}{hdr}")
    dups = []
    for a in names:
        row = ""
        da = deltas[a]
        na = sum(sum(c * c for c in v) for v in da) ** 0.5
        for b in names:
            db = deltas[b]
            nb = sum(sum(c * c for c in v) for v in db) ** 0.5
            if na < 1e-9 or nb < 1e-9:
                row += f"{'-':>7}"
                continue
            dot = sum(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]
                      for va, vb in zip(da, db))
            c = dot / (na * nb)
            row += f"{c:>7.2f}"
            if a < b and c > 0.97:
                dups.append((a, b, c))
        print(f"  {a:<12}{row}")
    if dups:
        print("\n  !! NEAR-DUPLICATE shapes (cos > 0.97) — these will look "
              "identical on screen:")
        for a, b, c in dups:
            print(f"     {a} ~= {b}  ({c:.3f})")
    else:
        print("\n  all viseme pairs are visually distinct (cos <= 0.97)")


if __name__ == "__main__":
    main(sys.argv[1],
         sys.argv[2] if len(sys.argv) > 2 else None,
         int(sys.argv[3]) if len(sys.argv) > 3 else None)
