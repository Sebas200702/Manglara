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
});
