"""Check that the hair chains are real: bones exist, are parented, are skinned.

Every precondition DynamicBones.setup() throws on, plus the one it cannot check -
whether any vertex is actually weighted to the chain. A bone that exists but
carries no weight produces a silent no-op: the physics runs, nothing moves.

Usage: python diag_hair_bones.py <file.glb>
"""
import sys
from collections import defaultdict
from pathlib import Path

from diag_morphs import load, read_accessor


def main(path):
    g, blob = load(path)
    nodes = g["nodes"]
    skin = g["skins"][0]
    joints = skin["joints"]
    name_of = lambda i: nodes[i].get("name")

    parent_of = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent_of[c] = i

    hair = [i for i in joints if (name_of(i) or "").startswith("Hair")]
    print(f"== {Path(path).name} ==")
    print(f"{len(joints)} joints, {len(hair)} hair bones")
    if not hair:
        print("!! no bones named Hair* - add_hair_bones.py did not run")
        return

    for ni in hair:
        p = parent_of.get(ni)
        pname = name_of(p) if p is not None else None
        is_bone_parent = p in joints if p is not None else False
        t = nodes[ni].get("translation", [0, 0, 0])
        flag = "" if is_bone_parent else "  !! parent is not a joint - setup() throws"
        print(f"  {name_of(ni):<8} parent={pname!r:<12} "
              f"offset={[round(x, 4) for x in t]} len={sum(x*x for x in t) ** 0.5:.4f}"
              f"{flag}")

    # Weights actually reaching those joints.
    jindex = {j: k for k, j in enumerate(joints)}
    hair_slots = {jindex[i]: name_of(i) for i in hair}
    totals = defaultdict(float)
    counts = defaultdict(int)
    for m in g["meshes"]:
        for p in m["primitives"]:
            a = p.get("attributes", {})
            if "JOINTS_0" not in a or "WEIGHTS_0" not in a:
                continue
            js = read_accessor(g, blob, a["JOINTS_0"])
            ws = read_accessor(g, blob, a["WEIGHTS_0"])
            wacc = g["accessors"][a["WEIGHTS_0"]]
            scale = {5121: 255.0, 5123: 65535.0}.get(wacc["componentType"], 1.0)
            for jv, wv in zip(js, ws):
                for k in range(4):
                    if jv[k] in hair_slots and wv[k] > 0:
                        nm = hair_slots[jv[k]]
                        totals[(m.get("name"), nm)] += wv[k] / scale
                        counts[(m.get("name"), nm)] += 1

    if not counts:
        print("\n!! NO vertex is weighted to any hair bone - the chain will "
              "move but the mesh will not follow it")
        return
    print("\n  weighted vertices per bone:")
    for (mesh, bone), n in sorted(counts.items()):
        print(f"    {mesh:<16} {bone:<8} n={n:<5} total weight={totals[(mesh, bone)]:.2f}")


if __name__ == "__main__":
    main(sys.argv[1])
