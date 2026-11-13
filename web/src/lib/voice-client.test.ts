import { afterEach, describe, expect, test } from "bun:test";
import { CALL_ERROR_MESSAGES } from "./call-errors";
import { requestCallMedia, VoiceClient } from "./voice-client";

type SocketHandler = (() => void) | null;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: SocketHandler = null;
  onclose: SocketHandler = null;
  onerror: SocketHandler = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor() {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  fail(): void {
    this.onerror?.();
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverSends(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  ready(): void {
    this.serverSends({ type: "session_ready" });
  }

  send(): void {}
}

const originalWebSocket = globalThis.WebSocket;
const originalWindow = globalThis.window;

function useFakeSocket(): void {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connects a client through the handshake and marks the call live. */
async function connectLive(client: VoiceClient): Promise<FakeWebSocket> {
  const connecting = client.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.ready();
  await connecting;
  client.markActive();
  return socket;
}

function withoutBackoff(client: VoiceClient): void {
  Object.defineProperty(client, "reconnectBaseMs", { value: 0 });
  Object.defineProperty(client, "reconnectMaxDelayMs", { value: 0 });
}

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.window = originalWindow;
  FakeWebSocket.instances = [];
});

describe("VoiceClient automatic reconnection", () => {
  test("retries after a failed reconnect instead of getting stuck", async () => {
    useFakeSocket();
    const reconnected: string[] = [];
    const client = new VoiceClient({
      onReconnected: () => reconnected.push("yes"),
    });
    withoutBackoff(client);

    const first = await connectLive(client);

    // Reconnection can reuse the already-open media pipeline.
    Object.assign(client, { micStream: { getTracks: () => [] } });
    first.close();
    await tick(50);

    FakeWebSocket.instances[1]!.fail();
    await tick(50);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2]!.open();
    FakeWebSocket.instances[2]!.ready();
    await tick();

    expect(client.isConnected).toBe(true);
    expect(reconnected).toEqual(["yes"]);
    client.disconnect();
  });

  test("gives up when the server keeps rejecting right after the socket opens", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
    let failed = 0;
    const client = new VoiceClient({ onReconnectFailed: () => failed++ });
    Object.defineProperty(client, "reconnectBaseMs", { value: 0 });
    Object.defineProperty(client, "reconnectMaxDelayMs", { value: 0 });

    const initialConnect = client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.ready();
    await initialConnect;
    client.markActive();
    Object.assign(client, { micStream: { getTracks: () => [] } });
    FakeWebSocket.instances[0]!.close();

    // Server full: every reconnect opens, gets the busy error, and is closed.
    for (let i = 1; i <= 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const ws = FakeWebSocket.instances[i];
      if (!ws) break;
      ws.open();
      // The server answers after the open is processed by the client.
      await new Promise((resolve) => setTimeout(resolve, 0));
      ws.onmessage?.({ data: JSON.stringify({ type: "error", message: "busy" }) } as MessageEvent);
      ws.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 1 initial socket + maxReconnectAttempts (6) retries, then it stops.
    expect(FakeWebSocket.instances).toHaveLength(7);
    expect(failed).toBe(1);
    client.disconnect();
  });

  test("a session the server ended for inactivity does not auto-reconnect", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
    const ended: string[] = [];
    const client = new VoiceClient({ onSessionEnded: (m) => ended.push(m) });
    Object.defineProperty(client, "reconnectBaseMs", { value: 0 });
    Object.defineProperty(client, "reconnectMaxDelayMs", { value: 0 });

    const initialConnect = client.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.ready();
    await initialConnect;
    client.markActive();
    ws.onmessage?.({ data: JSON.stringify({ type: "session_ended", message: "idle" }) } as MessageEvent);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ended).toEqual(["idle"]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    client.disconnect();
  });

  test("a successful session resets the retry budget", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
    const client = new VoiceClient({});
    Object.defineProperty(client, "reconnectBaseMs", { value: 0 });
    Object.defineProperty(client, "reconnectMaxDelayMs", { value: 0 });

    const initialConnect = client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.ready();
    await initialConnect;
    client.markActive();
    Object.assign(client, { micStream: { getTracks: () => [] } });
    FakeWebSocket.instances[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const ws = FakeWebSocket.instances[1]!;
    ws.open();
    ws.onmessage?.({ data: JSON.stringify({ type: "session_ready" }) } as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((client as unknown as { reconnectAttempts: number }).reconnectAttempts).toBe(0);
    client.disconnect();
  });
  test("announces reconnecting and reports a final failure", async () => {
    useFakeSocket();
    const states: string[] = [];
    const attempts: number[] = [];
    let failed = 0;
    const client = new VoiceClient({
      onConnectionChange: (state) => states.push(state),
      onReconnecting: (attempt) => attempts.push(attempt),
      onReconnectFailed: () => {
        failed += 1;
      },
    });
    withoutBackoff(client);
    Object.defineProperty(client, "maxReconnectAttempts", { value: 1 });

    const first = await connectLive(client);
    first.close();
    expect(states.at(-1)).toBe("reconnecting");
    expect(attempts).toEqual([1]);
    await tick(20);

    FakeWebSocket.instances[1]!.fail();
    await tick(20);
    expect(failed).toBe(1);
    expect(states.at(-1)).toBe("error");
    client.disconnect();
  });

  test("a close before markActive is not treated as a drop", async () => {
    useFakeSocket();
    const client = new VoiceClient();
    const connecting = client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.ready();
    await connecting;

    FakeWebSocket.instances[0]!.close();
    await tick(20);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("VoiceClient session gating", () => {
  test("connect() waits for session_ready, not just the socket opening", async () => {
    useFakeSocket();
    const states: string[] = [];
    const client = new VoiceClient({ onConnectionChange: (state) => states.push(state) });
    let resolved = false;
    const connecting = client.connect().then(() => {
      resolved = true;
    });

    FakeWebSocket.instances[0]!.open();
    await tick();
    expect(resolved).toBe(false);
    expect(states).not.toContain("connected");

    FakeWebSocket.instances[0]!.ready();
    await connecting;
    expect(resolved).toBe(true);
    expect(states.at(-1)).toBe("connected");
    client.disconnect();
  });

  test("a server error before session_ready rejects with a user-facing message", async () => {
    useFakeSocket();
    const errors: string[] = [];
    const client = new VoiceClient({ onError: (message) => errors.push(message) });
    const connecting = client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.serverSends({ type: "error", message: "Origen no permitido" });
    socket.close();

    await expect(connecting).rejects.toThrow(CALL_ERROR_MESSAGES.originRejected);
    // The caller shows the rejection; no duplicate banner through onError.
    expect(errors).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("the busy message reaches the user unchanged", async () => {
    useFakeSocket();
    const busy = "Manglara está atendiendo a muchas personas. Intenta de nuevo en un momento.";
    const client = new VoiceClient();
    const connecting = client.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.serverSends({ type: "error", message: busy });

    await expect(connecting).rejects.toThrow(busy);
  });

  test("a socket failure rejects with the Spanish network message", async () => {
    useFakeSocket();
    const client = new VoiceClient();
    const connecting = client.connect();
    FakeWebSocket.instances[0]!.fail();

    await expect(connecting).rejects.toThrow(CALL_ERROR_MESSAGES.network);
  });

  test("gives up when session_ready never arrives", async () => {
    useFakeSocket();
    const client = new VoiceClient();
    Object.defineProperty(client, "sessionReadyTimeoutMs", { value: 5 });
    const connecting = client.connect();
    FakeWebSocket.instances[0]!.open();

    await expect(connecting).rejects.toThrow(CALL_ERROR_MESSAGES.timeout);
  });

  test("a mid-call server error is mapped before reaching onError", async () => {
    useFakeSocket();
    const errors: string[] = [];
    const client = new VoiceClient({ onError: (message) => errors.push(message) });
    const socket = await connectLive(client);
    socket.serverSends({ type: "error", message: "upstream exploded" });

    expect(errors).toEqual([CALL_ERROR_MESSAGES.serverUnavailable]);
    client.disconnect();
  });
});

describe("requestCallMedia", () => {
  const stream = { id: "s" } as unknown as MediaStream;

  test("asks for microphone and camera together first", async () => {
    const calls: MediaStreamConstraints[] = [];
    const result = await requestCallMedia(async (constraints) => {
      calls.push(constraints);
      return stream;
    });
    expect(result).toBe(stream);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.video).toBeTruthy();
  });

  test("falls back to audio only when the camera fails", async () => {
    const calls: MediaStreamConstraints[] = [];
    const result = await requestCallMedia(async (constraints) => {
      calls.push(constraints);
      if (constraints.video) throw new DOMException("no cam", "NotFoundError");
      return stream;
    });
    expect(result).toBe(stream);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.video).toBeFalsy();
  });

  test("reports the microphone problem in Spanish when audio also fails", async () => {
    const attempt = requestCallMedia(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    await expect(attempt).rejects.toThrow(CALL_ERROR_MESSAGES.micDenied);
  });
});
