"""Deep morph-target (shape key) diagnostic for a GLB. No Blender needed.

Reports, per mesh primitive: how many targets it carries, whether the delta
accessors are actually non-zero, how far each morph moves geometry, whether
NORMAL deltas exist, and whether the node weight array lines up. Flags the
classic breakages: dead (all-zero) morphs, targets missing on some primitives
of a multi-material mesh, missing extras.targetNames (=> no
morphTargetDictionary in three.js), and nonzero baked-in node weights.

Usage: python diag_morphs.py <file.glb> [mesh_name]
"""
import json
import struct
import sys
from pathlib import Path

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2),
        5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def load(path):
    data = Path(path).read_bytes()
    total = struct.unpack("<I", data[8:12])[0]
    off, js, bin_chunk = 12, None, None
    while off < total:
        clen, ctype = struct.unpack("<II", data[off:off + 8])
        chunk = data[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode("utf-8"))
        elif ctype == 0x004E4942:
            bin_chunk = chunk
        off += 8 + clen
    return js, bin_chunk


def read_accessor(g, blob, idx):
    """Return list of tuples (handles sparse + normalized int types)."""
    acc = g["accessors"][idx]
    n = acc["count"]
    ncomp = NCOMP[acc["type"]]
    fmt, size = COMP[acc["componentType"]]
    out = [(0.0,) * ncomp] * n
    if "bufferView" in acc:
        bv = g["bufferViews"][acc["bufferView"]]
        base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = bv.get("byteStride") or size * ncomp
        vals = []
        for i in range(n):
            o = base + i * stride
            vals.append(struct.unpack_from("<" + fmt * ncomp, blob, o))
        out = vals
    if "sparse" in acc:
        sp = acc["sparse"]
        ifmt, isize = COMP[sp["indices"]["componentType"]]
        ibv = g["bufferViews"][sp["indices"]["bufferView"]]
        ibase = ibv.get("byteOffset", 0) + sp["indices"].get("byteOffset", 0)
        vbv = g["bufferViews"][sp["values"]["bufferView"]]
        vbase = vbv.get("byteOffset", 0) + sp["values"].get("byteOffset", 0)
        out = list(out)
        for k in range(sp["count"]):
            vi = struct.unpack_from("<" + ifmt, blob, ibase + k * isize)[0]
            out[vi] = struct.unpack_from(
                "<" + fmt * ncomp, blob, vbase + k * size * ncomp)
    return out


def main(path, only_mesh=None):
    g, blob = load(path)
    print(f"== {Path(path).name} ==")
    node_of_mesh = {}
    for ni, nd in enumerate(g.get("nodes", [])):
        if "mesh" in nd:
            node_of_mesh.setdefault(nd["mesh"], []).append((ni, nd))

    for mi, m in enumerate(g["meshes"]):
        name = m.get("name")
        if only_mesh and name != only_mesh:
            continue
        prims = m["primitives"]
        tnames = (m.get("extras") or {}).get("targetNames") or []
        counts = [len(p.get("targets", [])) for p in prims]
        if not any(counts):
            continue
        print(f"\n--- mesh[{mi}] '{name}' — {len(prims)} prim(s), "
              f"targets/prim={counts}")
        if not tnames:
            print("  !! NO extras.targetNames -> three.js gets no "
                  "morphTargetDictionary (names unusable)")
        elif len(tnames) != max(counts):
            print(f"  !! targetNames={len(tnames)} != targets={max(counts)}")
        if len(set(counts)) > 1:
            print("  !! primitives disagree on target count — prims with 0 "
                  "targets will NOT deform (invalid glTF)")

        for ni, nd in node_of_mesh.get(mi, []):
            w = nd.get("weights")
            if w:
                nz = [(tnames[i] if i < len(tnames) else i, round(x, 3))
                      for i, x in enumerate(w) if abs(x) > 1e-6]
                print(f"  node[{ni}] '{nd.get('name')}' weights len={len(w)}"
                      + (f" NONZERO {nz}" if nz else " (all zero, ok)"))
            else:
                print(f"  node[{ni}] '{nd.get('name')}' has no weights array "
                      "(defaults to 0, ok)")

        for pi, p in enumerate(prims):
            tg = p.get("targets", [])
            if not tg:
                print(f"  prim[{pi}] mat="
                      f"{g['materials'][p['material']].get('name') if 'material' in p else None}"
                      "  NO TARGETS -> static")
                continue
            npos = g["accessors"][p["attributes"]["POSITION"]]["count"]
            mat = (g["materials"][p["material"]].get("name")
                   if "material" in p else None)
            print(f"  prim[{pi}] mat={mat} verts={npos} targets={len(tg)}")
            dead, weak = [], []
            rows = []
            for ti, t in enumerate(tg):
                tn = tnames[ti] if ti < len(tnames) else f"#{ti}"
                if "POSITION" not in t:
                    dead.append(tn + "(no POSITION)")
                    continue
                acc = g["accessors"][t["POSITION"]]
                deltas = read_accessor(g, blob, t["POSITION"])
                moved = 0
                mx = 0.0
                for d in deltas:
                    s = abs(d[0]) + abs(d[1]) + abs(d[2])
                    if s > 1e-6:
                        moved += 1
                        mag = (d[0] ** 2 + d[1] ** 2 + d[2] ** 2) ** 0.5
                        mx = max(mx, mag)
                has_n = "NORMAL" in t
                sparse = "sparse" in acc
                rows.append((tn, moved, npos, mx, has_n, sparse))
                if moved == 0:
                    dead.append(tn)
                elif mx < 1e-4:
                    weak.append(f"{tn}({mx:.2e})")
            for tn, moved, npos, mx, has_n, sparse in rows:
                flag = "DEAD " if moved == 0 else ("weak " if mx < 1e-4 else "     ")
                print(f"    {flag}{tn:<22} verts_moved={moved:>6}/{npos} "
                      f"max_disp={mx:.5f} normals={'y' if has_n else 'n'} "
                      f"{'sparse' if sparse else ''}")
            print(f"    => {len(rows) - len(dead)} live, {len(dead)} dead"
                  + (f" DEAD: {dead}" if dead else ""))
            if weak:
                print(f"    => WEAK (barely moves): {weak}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
