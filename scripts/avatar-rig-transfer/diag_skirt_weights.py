"""Which bones drive the skirt? Answers why posing the legs wrecks the hem.

A flared skirt is a rigid shell in real life: it hangs off the hips and the legs
move *inside* it. If the exporter's automatic weights bound it to the thigh
bones instead, then every step, stance change or idle sway drags the fabric with
the leg and the hem collapses and spikes.

Usage: python diag_skirt_weights.py <file.glb> [material] [waist_y]
"""
import sys
from collections import defaultdict
from pathlib import Path

from diag_morphs import load, read_accessor


def main(path, material="camisa", waist=None):
    g, blob = load(path)
    joints = g["skins"][0]["joints"]
    bone = lambda slot: g["nodes"][joints[slot]].get("name")

    for m in g["meshes"]:
        for p in m["primitives"]:
            mat = (g["materials"][p["material"]].get("name")
                   if "material" in p else None)
            if not mat or material not in mat:
                continue
            a = p["attributes"]
            pos = read_accessor(g, blob, a["POSITION"])
            js = read_accessor(g, blob, a["JOINTS_0"])
            ws = read_accessor(g, blob, a["WEIGHTS_0"])
            wacc = g["accessors"][a["WEIGHTS_0"]]
            scale = {5121: 255.0, 5123: 65535.0}.get(wacc["componentType"], 1.0)

            ys = [v[1] for v in pos]
            lo, hi = min(ys), max(ys)
            cut = waist if waist is not None else lo + (hi - lo) * 0.55
            print(f"\n== {Path(path).name} :: '{m.get('name')}' mat={mat} ==")
            print(f"   y {lo:.3f}..{hi:.3f}, skirt = below y={cut:.3f}")

            for label, test in (("SKIRT (below waist)", lambda y: y < cut),
                                ("BODICE (above waist)", lambda y: y >= cut)):
                tot = defaultdict(float)
                n = 0
                for v, jv, wv in zip(pos, js, ws):
                    if not test(v[1]):
                        continue
                    n += 1
                    for k in range(4):
                        w = wv[k] / scale
                        if w > 0:
                            tot[bone(jv[k])] += w
                if not n:
                    continue
                s = sum(tot.values()) or 1.0
                print(f"   {label}: {n} verts")
                for b, w in sorted(tot.items(), key=lambda x: -x[1]):
                    share = w / s * 100
                    leg = any(t in (b or "") for t in ("UpLeg", "Leg", "Foot", "Toe"))
                    mark = "  <-- LEG BONE" if leg and share > 1 else ""
                    print(f"      {b:<20} {share:5.1f}%{mark}")


if __name__ == "__main__":
    main(sys.argv[1],
         sys.argv[2] if len(sys.argv) > 2 else "camisa",
         float(sys.argv[3]) if len(sys.argv) > 3 else None)
