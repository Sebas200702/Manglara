import { describe, expect, test } from "bun:test";
import {
  CALL_ERROR_MESSAGES,
  CallError,
  describeMediaError,
  describeServerError,
  toUserMessage,
} from "./call-errors";

function mediaError(name: string): DOMException {
  return new DOMException("Permission denied by system", name);
}

describe("describeMediaError", () => {
  test("maps a denied permission to how to enable the microphone", () => {
    expect(describeMediaError(mediaError("NotAllowedError"))).toBe(CALL_ERROR_MESSAGES.micDenied);
    expect(CALL_ERROR_MESSAGES.micDenied).toContain("candado");
  });

  test("maps a missing device", () => {
    expect(describeMediaError(mediaError("NotFoundError"))).toBe(CALL_ERROR_MESSAGES.micNotFound);
  });

  test("maps a device busy in another app", () => {
    expect(describeMediaError(mediaError("NotReadableError"))).toBe(CALL_ERROR_MESSAGES.micInUse);
  });

  test("maps unsatisfiable constraints", () => {
    expect(describeMediaError(mediaError("OverconstrainedError"))).toBe(
      CALL_ERROR_MESSAGES.micConstraints
    );
  });

  test("falls back to a generic Spanish message, never the raw browser text", () => {
    const message = describeMediaError(new Error("Requested device not found"));
    expect(message).toBe(CALL_ERROR_MESSAGES.unknown);
  });
});

describe("describeServerError", () => {
  test("translates the origin rejection into something the user can act on", () => {
    expect(describeServerError("Origen no permitido")).toBe(CALL_ERROR_MESSAGES.originRejected);
  });

  test("keeps the busy message as the server wrote it", () => {
    const busy = "Manglara está atendiendo a muchas personas. Intenta de nuevo en un momento.";
    expect(describeServerError(busy)).toBe(busy);
  });

  test("hides raw upstream exception text", () => {
    expect(describeServerError("received 1011 (internal error) keepalive ping timeout")).toBe(
      CALL_ERROR_MESSAGES.serverUnavailable
    );
  });
});

describe("toUserMessage", () => {
  test("passes CallError messages through", () => {
    expect(toUserMessage(new CallError(CALL_ERROR_MESSAGES.network))).toBe(
      CALL_ERROR_MESSAGES.network
    );
  });

  test("maps media errors", () => {
    expect(toUserMessage(mediaError("NotAllowedError"))).toBe(CALL_ERROR_MESSAGES.micDenied);
  });

  test("never leaks an English error message", () => {
    expect(toUserMessage(new Error("WebSocket connection failed"))).toBe(
      CALL_ERROR_MESSAGES.unknown
    );
    expect(toUserMessage("boom")).toBe(CALL_ERROR_MESSAGES.unknown);
  });
});
