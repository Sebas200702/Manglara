import { describe, expect, test } from "bun:test";
import {
  detectProvider,
  isTerminal,
  parseMeetingEvent,
  parseMeetingState,
} from "./meeting-client";

const STATE = {
  id: "abc123",
  provider: "zoom",
  name: "Manglara",
  bridge: "in_meeting",
  brain: "off",
  mic_enabled: false,
  cam_enabled: true,
  error: null,
  end_reason: null,
};

describe("parseMeetingEvent", () => {
  test("parses a state event", () => {
    const ev = parseMeetingEvent(JSON.stringify({ type: "state", ...STATE }));
    expect(ev).toEqual({ type: "state", ...STATE } as never);
  });

  test("rejects a state with an unknown bridge state", () => {
    const ev = parseMeetingEvent(JSON.stringify({ type: "state", ...STATE, bridge: "dancing" }));
    expect(ev).toBeNull();
  });

  test("rejects a state with an unknown provider", () => {
    expect(parseMeetingState({ ...STATE, provider: "webex" })).toBeNull();
  });

  test("keeps known end reasons and drops unknown ones", () => {
    expect(parseMeetingState({ ...STATE, bridge: "closed", end_reason: "alone" })?.end_reason).toBe(
      "alone"
    );
    expect(parseMeetingState({ ...STATE, end_reason: "kicked" })?.end_reason).toBeNull();
  });

  test("normalizes an empty error to null", () => {
    expect(parseMeetingState({ ...STATE, error: "" })?.error).toBeNull();
  });

  test("parses transcripts for both roles", () => {
    expect(
      parseMeetingEvent(JSON.stringify({ type: "transcript", role: "participant", text: "hola" }))
    ).toEqual({ type: "transcript", role: "participant", text: "hola" });
    expect(
      parseMeetingEvent(JSON.stringify({ type: "transcript", role: "manglara", text: "buenas" }))
    ).toEqual({ type: "transcript", role: "manglara", text: "buenas" });
  });

  test("rejects transcripts with an unknown role", () => {
    expect(
      parseMeetingEvent(JSON.stringify({ type: "transcript", role: "user", text: "x" }))
    ).toBeNull();
  });

  test("parses errors with a fallback message", () => {
    expect(parseMeetingEvent(JSON.stringify({ type: "error", message: "boom" }))).toEqual({
      type: "error",
      message: "boom",
    });
    expect(parseMeetingEvent(JSON.stringify({ type: "error" }))).toEqual({
      type: "error",
      message: "Error en la reunión",
    });
  });

  test("ignores invalid JSON and unknown types", () => {
    expect(parseMeetingEvent("not json")).toBeNull();
    expect(parseMeetingEvent(JSON.stringify({ type: "ping" }))).toBeNull();
    expect(parseMeetingEvent("42")).toBeNull();
  });
});

describe("detectProvider", () => {
  test.each([
    ["https://teams.microsoft.com/l/meetup-join/19%3ameeting_x", "teams"],
    ["https://teams.live.com/meet/9876543210", "teams"],
    ["https://us02web.zoom.us/j/81234567890?pwd=abc", "zoom"],
    ["zoom.us/j/81234567890", "zoom"],
    ["812 3456 7890", "zoom"],
    ["https://meet.google.com/abc-defg-hij", "meet"],
    ["abc-defg-hij", "meet"],
  ] as const)("%s -> %s", (input, provider) => {
    expect(detectProvider(input)).toBe(provider);
  });

  test.each(["", "   ", "https://example.com/meeting", "hola mundo", "12345"])(
    "%p -> null",
    (input) => {
      expect(detectProvider(input)).toBeNull();
    }
  );
});

describe("isTerminal", () => {
  test("only closed and error are terminal", () => {
    expect(isTerminal("closed")).toBe(true);
    expect(isTerminal("error")).toBe(true);
    expect(isTerminal("in_meeting")).toBe(false);
    expect(isTerminal("lobby")).toBe(false);
  });
});
