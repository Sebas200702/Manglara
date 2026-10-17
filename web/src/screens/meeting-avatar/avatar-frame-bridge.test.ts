import { describe, expect, test } from "bun:test";
import { parseBridgeMessage } from "./avatar-frame-bridge";

describe("parseBridgeMessage", () => {
  test("accepts every bridge message type", () => {
    const pcm = new ArrayBuffer(4);
    expect(parseBridgeMessage({ __manglara: "bridge", type: "pcm", data: pcm })).toEqual({
      type: "pcm",
      data: pcm,
    });
    expect(parseBridgeMessage({ __manglara: "bridge", type: "lip_text", text: "hola" })).toEqual({
      type: "lip_text",
      text: "hola",
    });
    expect(parseBridgeMessage({ __manglara: "bridge", type: "turn_end" })).toEqual({
      type: "turn_end",
    });
    expect(parseBridgeMessage({ __manglara: "bridge", type: "flush" })).toEqual({ type: "flush" });
    expect(parseBridgeMessage({ __manglara: "bridge", type: "state", state: "listening" })).toEqual(
      { type: "state", state: "listening" }
    );
  });

  test("ignores messages from anything but the bridge", () => {
    expect(parseBridgeMessage({ type: "flush" })).toBeNull();
    expect(parseBridgeMessage({ __manglara: "avatar", type: "flush" })).toBeNull();
    expect(parseBridgeMessage("flush")).toBeNull();
    expect(parseBridgeMessage(null)).toBeNull();
  });

  test("rejects malformed payloads", () => {
    expect(parseBridgeMessage({ __manglara: "bridge", type: "pcm", data: "AAAA" })).toBeNull();
    expect(parseBridgeMessage({ __manglara: "bridge", type: "lip_text", text: 3 })).toBeNull();
    expect(parseBridgeMessage({ __manglara: "bridge", type: "state", state: "dancing" })).toBeNull();
    expect(parseBridgeMessage({ __manglara: "bridge", type: "unknown" })).toBeNull();
  });
});
