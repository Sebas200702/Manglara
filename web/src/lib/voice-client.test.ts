import { afterEach, describe, expect, test } from "bun:test";
import { VoiceClient } from "./voice-client";

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

  /** Deliver a server frame, as the real socket would. */
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.window = originalWindow;
  FakeWebSocket.instances = [];
});

/** Installs the fakes and returns a client with instant backoff. */
function makeClient(
  callbacks: ConstructorParameters<typeof VoiceClient>[0] = {},
  overrides: Record<string, number> = {}
): VoiceClient {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
  const client = new VoiceClient(callbacks);
  Object.defineProperty(client, "reconnectBaseMs", { value: 0 });
  Object.defineProperty(client, "reconnectMaxDelayMs", { value: 0 });
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(client, key, { value });
  }
  return client;
}

/** Bring a client up to "in a live call", ready to have the link broken. */
async function startLiveCall(client: VoiceClient): Promise<FakeWebSocket> {
  const connecting = client.connect();
  FakeWebSocket.instances[0]!.open();
  await connecting;
  client.markActive();
  // Reconnection can reuse the already-open media pipeline.
  Object.assign(client, { micStream: { getTracks: () => [] } });
  return FakeWebSocket.instances[0]!;
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describe("VoiceClient automatic reconnection", () => {
  test("keeps retrying until the connection is restored", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
    const client = new VoiceClient();
    Object.defineProperty(client, "reconnectBaseMs", { value: 0 });
    Object.defineProperty(client, "reconnectMaxDelayMs", { value: 0 });

    const initialConnect = client.connect();
    FakeWebSocket.instances[0]!.open();
    await initialConnect;
    client.markActive();
    Object.assign(client, { micStream: { getTracks: () => [] } });
    FakeWebSocket.instances[0]!.close();

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const socket = FakeWebSocket.instances[attempt];
      expect(socket).toBeDefined();
      socket?.fail();
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(FakeWebSocket.instances).toHaveLength(9);
    FakeWebSocket.instances[8]!.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  test("retries after a failed reconnect instead of getting stuck", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
    const reconnected: string[] = [];
    const client = new VoiceClient({
      onReconnected: () => reconnected.push("yes"),
    });
    Object.defineProperty(client, "reconnectBaseMs", { value: 0 });
    Object.defineProperty(client, "reconnectMaxDelayMs", { value: 0 });

    const initialConnect = client.connect();
    FakeWebSocket.instances[0]!.open();
    await initialConnect;
    client.markActive();

    // Reconnection can reuse the already-open media pipeline.
    Object.assign(client, { micStream: { getTracks: () => [] } });
    FakeWebSocket.instances[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    FakeWebSocket.instances[1]!.fail();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2]!.open();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.isConnected).toBe(true);
    expect(reconnected).toEqual(["yes"]);
    client.disconnect();
  });

  test("does not reconnect after an intentional hang-up", async () => {
    const client = makeClient();
    await startLiveCall(client);

    client.disconnect();
    await tick();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.isConnected).toBe(false);
  });
});

describe("VoiceClient heartbeat", () => {
  test("answers a server ping with a pong", async () => {
    const client = makeClient();
    const socket = await startLiveCall(client);

    socket.receive({ type: "ping" });

    expect(socket.sent).toContain(JSON.stringify({ type: "pong" }));
    client.disconnect();
  });

  test("reconnects a half-open socket that stopped answering", async () => {
    // The socket stays OPEN and never fires `onclose` - the case `readyState`
    // cannot detect. Only the silence watchdog can.
    const states: string[] = [];
    const client = makeClient(
      { onConnectionChange: (state) => states.push(state) },
      { heartbeatIntervalMs: 5, heartbeatTimeoutMs: 20 }
    );
    const socket = await startLiveCall(client);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    await tick(80);

    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    const replacement = FakeWebSocket.instances.at(-1)!;
    replacement.open();
    // Well inside the (deliberately tiny) timeout, so the watchdog does not
    // immediately declare the fresh socket dead too.
    await tick(1);

    expect(client.isConnected).toBe(true);
    expect(states).toContain("connecting");
    client.disconnect();
  });

  test("traffic from the server keeps the socket alive", async () => {
    const client = makeClient({}, { heartbeatIntervalMs: 5, heartbeatTimeoutMs: 40 });
    const socket = await startLiveCall(client);

    // Answer every ping, as a healthy server would.
    for (let i = 0; i < 8; i += 1) {
      await tick(10);
      socket.receive({ type: "pong" });
    }

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });
});

describe("VoiceClient error reporting", () => {
  test("a mid-call socket error is healed silently, not surfaced", async () => {
    const errors: string[] = [];
    const client = makeClient({ onError: (message) => errors.push(message) });
    const socket = await startLiveCall(client);

    // A drop mid-call fires onerror then onclose. The user is still in a call;
    // this is the client's problem to fix, not a banner to show.
    socket.fail();
    await tick();

    expect(errors).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.disconnect();
  });

  test("a failed initial connect rejects instead of retrying", async () => {
    const client = makeClient();
    const connecting = client.connect();
    FakeWebSocket.instances[0]!.fail();

    await expect(connecting).rejects.toThrow();
    await tick();
    // `markActive` was never reached, so nothing should be retrying.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
