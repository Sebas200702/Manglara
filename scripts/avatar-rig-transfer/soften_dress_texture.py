"""Soften the embedded dress texture and its glTF material."""

import argparse
import io
import json
import struct
from pathlib import Path

from PIL import Image, ImageEnhance


JSON = 0x4E4F534A
BIN = 0x004E4942


def chunk(kind, body):
    return struct.pack("<II", len(body), kind) + body


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("glb", type=Path)
    parser.add_argument("--material", default="camisa")
    parser.add_argument("--image", default="textura_falda")
    parser.add_argument("--saturation", type=float, default=0.72)
    parser.add_argument("--contrast", type=float, default=0.88)
    parser.add_argument("--brightness", type=float, default=0.96)
    parser.add_argument("--roughness", type=float, default=0.88)
    args = parser.parse_args()

    data = args.glb.read_bytes()
    offset = 12
    json_body = None
    bin_body = None
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        body = data[offset + 8:offset + 8 + length]
        if kind == JSON:
            json_body = body
        elif kind == BIN:
            bin_body = bytearray(body)
        offset += 8 + length
    if json_body is None or bin_body is None:
        raise RuntimeError("GLB must contain JSON and BIN chunks")

    gltf = json.loads(json_body.rstrip(b" \t\r\n\0"))
    material = next(
        (m for m in gltf.get("materials", []) if m.get("name") == args.material),
        None,
    )
    if material is None:
        raise RuntimeError(f"Material not found: {args.material}")
    texture_index = material.get("pbrMetallicRoughness", {}).get(
        "baseColorTexture", {}
    ).get("index")
    if texture_index is None:
        raise RuntimeError(f"Material has no base color texture: {args.material}")
    image_index = gltf["textures"][texture_index]["source"]
    image = gltf["images"][image_index]
    if image.get("name") != args.image:
        raise RuntimeError(
            f"Expected image {args.image!r}, got {image.get('name')!r}"
        )

    view_index = image["bufferView"]
    view = gltf["bufferViews"][view_index]
    start = view.get("byteOffset", 0)
    end = start + view["byteLength"]
    original = Image.open(io.BytesIO(bin_body[start:end])).convert("RGBA")
    softened = ImageEnhance.Color(original).enhance(args.saturation)
    softened = ImageEnhance.Contrast(softened).enhance(args.contrast)
    softened = ImageEnhance.Brightness(softened).enhance(args.brightness)
    encoded = io.BytesIO()
    softened.save(encoded, format="PNG", optimize=True)
    image_bytes = encoded.getvalue()
    replacement = image_bytes + b"\0" * ((4 - len(image_bytes) % 4) % 4)

    # Replace the image bytes and shift later buffer views if PNG compression
    # changed the payload size.
    delta = len(replacement) - (end - start)
    bin_body = bin_body[:start] + replacement + bin_body[end:]
    view["byteLength"] = len(image_bytes)
    for other in gltf["bufferViews"]:
        other_start = other.get("byteOffset", 0)
        if other is not view and other_start >= end:
            other["byteOffset"] = other_start + delta

    pbr = material.setdefault("pbrMetallicRoughness", {})
    pbr["roughnessFactor"] = args.roughness

    new_json = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    new_json += b" " * ((4 - len(new_json) % 4) % 4)
    output = bytearray(data[:12])
    output += chunk(JSON, new_json)
    output += chunk(BIN, bytes(bin_body))
    struct.pack_into("<I", output, 8, len(output))
    args.glb.write_bytes(output)
    print(
        f"softened {args.image}: saturation={args.saturation}, "
        f"contrast={args.contrast}, brightness={args.brightness}, "
        f"roughness={args.roughness}"
    )


if __name__ == "__main__":
    main()
