"""
Stop the dress ballooning AND arm boil/deformation when the limbs move,
WITHOUT re-solving skin weights.

Root cause (see memory gesture-rig-validation): the body+dress+arms are one Tripo
skinned mesh whose weights are smeared - skirt/leg vertices carry weight on arm bones
(so any arm rotation drags the skirt), AND arm vertices carry weight on body/torso
bones (so arm movement pulls torso and arm geometry boils/collapses).

Fix (deterministic, no solver, no bind-pose dependency): classify every vertex by its
DOMINANT bone (the one with the largest weight).
  - Dominant bone is NOT an arm bone (it's torso/legs/hips/head) -> this is body/skirt
    geometry. Strip any weight it carries on ARM bones and renormalize onto its remaining
    (body/leg) bones. The skirt no longer follows the arm.
  - Dominant bone IS an arm bone -> this is real arm/hand geometry. Strip any weight it
    carries on NON-arm bones and renormalize. The arm no longer pulls body or boils.

This uses weight TOPOLOGY, not vertex position, so it is immune to the T-pose-bind /
arms-down-mesh space mismatch that broke the earlier position-based attacks.
"""
import sys
import numpy as np
import pygltflib

SRC = "web/public/custom_avatar.glb"
OUT = sys.argv[1] if len(sys.argv) > 1 else "web/public/custom_avatar.reweight.glb"

ARM_PREFIXES = ("LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
                "RightShoulder", "RightArm", "RightForeArm", "RightHand")

# Max fraction of an arm vertex's weight allowed to stay on body (chest/neck)
# bones. A little keeps the shoulder transition smooth; too much makes the
# shoulder balloon when the arm lifts (it gets torn between arm and chest).
MAX_BODY_FRAC = 0.15


def is_arm_bone(name: str) -> bool:
    return name.startswith(ARM_PREFIXES)


def accessor_np(gltf, blob, idx):
    acc = gltf.accessors[idx]
    bv = gltf.bufferViews[acc.bufferView]
    comp = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[acc.componentType]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc.type]
    start = (bv.byteOffset or 0) + (acc.byteOffset or 0)
    count = acc.count * ncomp
    arr = np.frombuffer(blob, dtype=comp, count=count, offset=start).reshape(acc.count, ncomp)
    return arr, acc, bv, comp, ncomp, start


def main():
    gltf = pygltflib.GLTF2().load(SRC)
    blob = bytearray(gltf.binary_blob())

    # joint slot -> node name (JOINTS_0 values index into skin.joints)
    skin = gltf.skins[0]
    joint_names = [gltf.nodes[n].name for n in skin.joints]
    arm_slots = np.array([is_arm_bone(n) for n in joint_names], dtype=bool)
    body_slots = ~arm_slots
    print(f"joints={len(joint_names)}  arm joints={int(arm_slots.sum())}")

    # locate the body mesh primitive, not the small MouthOverlay patch
    target = None
    for mesh in gltf.meshes:
        for prim in mesh.primitives:
            if prim.attributes.JOINTS_0 is None:
                continue
            pos_acc = gltf.accessors[prim.attributes.POSITION]
            if pos_acc.count > 1000:
                target = prim
                print(f"body primitive: {pos_acc.count} verts")
    if target is None:
        raise SystemExit("no skinned body primitive found")

    joints, jacc, jbv, jcomp, jn, jstart = accessor_np(gltf, blob, target.attributes.JOINTS_0)
    weights, wacc, wbv, wcomp, wn, wstart = accessor_np(gltf, blob, target.attributes.WEIGHTS_0)
    weights = weights.astype(np.float64)

    nv = joints.shape[0]
    dom_slot = joints[np.arange(nv), np.argmax(weights, axis=1)]
    dom_is_arm = arm_slots[dom_slot]

    infl_is_arm = arm_slots[joints]
    arm_frac = np.where(infl_is_arm, weights, 0).sum(1) / np.clip(weights.sum(1), 1e-8, None)
    body_frac = np.where(~infl_is_arm, weights, 0).sum(1) / np.clip(weights.sum(1), 1e-8, None)

    w = weights.copy()

    # --- PASS 1: body/skirt vertices --- strip arm bone influence ---
    fix_body = (~dom_is_arm) & (arm_frac > 1e-4)
    print(f"vertices total={nv}  arm-dominant={int(dom_is_arm.sum())}  "
          f"body-with-arm-smear(fixed)={int(fix_body.sum())}")

    w[fix_body] = np.where(infl_is_arm[fix_body], 0.0, weights[fix_body])
    row_sum = w.sum(1, keepdims=True)
    empty = (row_sum[:, 0] < 1e-6) & fix_body
    if empty.any():
        w[empty] = 0.0
        w[empty, 0] = 1.0
        joints[empty, 0] = 0  # Hips
        row_sum = w.sum(1, keepdims=True)
        print(f"  pinned {int(empty.sum())} pure-arm-smear verts to Hips")
    w = w / np.clip(row_sum, 1e-8, None)

    # --- PASS 2: arm vertices --- CAP (don't zero) body-bone influence ---
    # Diagnosis (see below): the ballooning is NOT the skirt following the arms
    # (body-with-arm-smear == 0). It is the shoulder/upper-arm verts (dominant on
    # LeftShoulder/RightShoulder) carrying up to 59% weight on Spine2 (the chest).
    # When a gesture rotates the arm, those verts are torn between the rotating
    # arm bone and the static chest, so the shoulder/chest region inflates.
    #
    # A little chest blend keeps the shoulder transition smooth, so we CAP the
    # body fraction rather than zeroing it (zeroing rigidifies the armpit into a
    # crease). Verts already under the cap are left untouched.
    infl_is_body = ~infl_is_arm
    over = dom_is_arm & (body_frac > MAX_BODY_FRAC)
    print(f"  arm-dominant={int(dom_is_arm.sum())}  "
          f"capped body_frac>{MAX_BODY_FRAC} on {int(over.sum())} shoulder verts")

    if over.any():
        idx = np.flatnonzero(over)
        bf = body_frac[idx]                       # current body fraction (> cap)
        af = arm_frac[idx]                        # current arm fraction (= 1 - bf)
        body_scale = MAX_BODY_FRAC / bf           # shrink body weights onto the cap
        arm_scale = (1.0 - MAX_BODY_FRAC) / np.clip(af, 1e-8, None)  # grow arm to fill
        wi = w[idx]
        ib = infl_is_body[idx]
        w[idx] = np.where(ib, wi * body_scale[:, None], wi * arm_scale[:, None])
    w = w / np.clip(w.sum(1, keepdims=True), 1e-8, None)

    # write back (same float32 layout / offsets)
    out = w.astype(np.float32)
    packed = out.tobytes()
    assert len(packed) == wacc.count * wn * 4
    blob[wstart:wstart + len(packed)] = packed
    jpacked = joints.astype({np.uint8: np.uint8, np.uint16: np.uint16}[jcomp]).tobytes()
    blob[jstart:jstart + len(jpacked)] = jpacked

    gltf.set_binary_blob(bytes(blob))
    gltf.save(OUT)
    print(f"saved {OUT}")


if __name__ == "__main__":
    main()
