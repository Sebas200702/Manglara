"""Quick GLB inventory: meshes, morph targets, COLOR_0, materials. No Blender."""
import json
import struct
import sys
from pathlib import Path


def gltf_json(path):
    data = Path(path).read_bytes()
    total = struct.unpack("<I", data[8:12])[0]
    off = 12
    while off < total:
        clen = struct.unpack("<I", data[off:off + 4])[0]
        ctype = struct.unpack("<I", data[off + 4:off + 8])[0]
        if ctype == 0x4E4F534A:
            return json.loads(data[off + 8:off + 8 + clen].decode("utf-8"))
        off += 8 + clen
    raise RuntimeError("no JSON chunk")


def main(path):
    g = gltf_json(path)
    accessor_of = lambda i: g["accessors"][i]
    names = g.get("extras", {}).get("targetNames") or []
    print(f"== {Path(path).name} ==")
    for m in g["meshes"]:
        prims = m.get("primitives", [])
        attrs = set()
        ntargets = 0
        tnames = []
        for p in prims:
            attrs.update(p.get("attributes", {}).keys())
            tg = p.get("targets", [])
            ntargets = max(ntargets, len(tg))
        tnames = m.get("extras", {}).get("targetNames", [])
        print(f"  mesh '{m.get('name')}': {len(prims)} prims, attrs={sorted(attrs)}, "
              f"targets={ntargets}")
        if tnames:
            print(f"    morphs: {tnames}")
    for n in g["nodes"]:
        if "mesh" in n:
            w = n.get("weights")
            if w and any(abs(x) > 1e-6 for x in w):
                print(f"  NODE '{n.get('name')}' has NONZERO weights {w}")
    mats = [m.get("name") for m in g.get("materials", [])]
    print(f"  materials: {mats}")
    # which meshes have COLOR_0-bearing prims
    for m in g["meshes"]:
        has = any("COLOR_0" in p.get("attributes", {}) for p in m["primitives"])
        if has:
            print(f"  COLOR_0 on '{m['name']}'")


if __name__ == "__main__":
    main(sys.argv[1])
