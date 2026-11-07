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

  send(): void {}
}

const originalWebSocket = globalThis.WebSocket;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.window = originalWindow;
  FakeWebSocket.instances = [];
});

describe("VoiceClient automatic reconnection", () => {
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

  test("gives up when the server keeps rejecting right after the socket opens", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    globalThis.window = { location: { protocol: "http:" } } as Window & typeof globalThis;
    const errors: string[] = [];
    const client = new VoiceClient({ onError: (m) => errors.push(m) });
    Object.defineProperty(client, "reconnectBaseMs", { value: 0 });
    Object.defineProperty(client, "reconnectMaxDelayMs", { value: 0 });

    const initialConnect = client.connect();
    FakeWebSocket.instances[0]!.open();
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
    expect(errors).toContain("No se pudo restablecer la conexión");
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
});
