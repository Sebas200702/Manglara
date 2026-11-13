import { afterEach, describe, expect, test } from "bun:test";
import {
  detectProvider,
  isTerminal,
  LOGIN_REQUIRED_MESSAGE,
  MeetingApiError,
  meetingApi,
  meetingWsUrl,
  parseMeetingEvent,
  SERVER_UNAVAILABLE_MESSAGE,
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

describe("meeting API transport", () => {
  const realFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  function stub(status: number, body: unknown, json = true) {
    calls.length = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(json ? JSON.stringify(body) : String(body), { status });
    }) as typeof fetch;
  }
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("calls the same-origin /api path so the admin cookie is sent", async () => {
    stub(200, { ok: true });
    await meetingApi.leave("abc");
    expect(calls[0].url).toBe("/api/meetings/abc/leave");
    expect(calls[0].init?.credentials).toBe("same-origin");
  });

  test("401 reads as a login hint in Spanish", async () => {
    stub(401, { detail: "No autenticado" });
    const err = await meetingApi.leave("abc").catch((e) => e);
    expect(err).toBeInstanceOf(MeetingApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe(LOGIN_REQUIRED_MESSAGE);
  });

  test("5xx without detail reads as server unavailable, not a raw code", async () => {
    stub(502, "<html>bad gateway</html>", false);
    const err = await meetingApi.leave("abc").catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toBe(SERVER_UNAVAILABLE_MESSAGE);
  });

  test("network failure keeps status 0 and a Spanish message", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const err = await meetingApi.leave("abc").catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.message).toBe("No se pudo contactar al servidor");
  });
});

describe("meetingWsUrl", () => {
  test("uses the page origin with wss on https", () => {
    expect(meetingWsUrl("a b", { protocol: "https:", host: "manglara.app" })).toBe(
      "wss://manglara.app/ws/meetings/a%20b"
    );
  });
  test("uses ws on http", () => {
    expect(meetingWsUrl("x", { protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/ws/meetings/x"
    );
  });
});
