/**
 * Protocol between the avatar page (`/meeting/avatar`, rendered inside a hidden
 * iframe of the meeting page) and the injected `server/meeting/audio_bridge.js`.
 *
 *   iframe -> parent  {__manglara:"avatar", type:"ready"}
 *                     {__manglara:"avatar", type:"frame", bitmap}   (transferred)
 *   parent -> iframe  {__manglara:"bridge", type:"pcm", data: ArrayBuffer}
 *                     {__manglara:"bridge", type:"lip_text", text}
 *                     {__manglara:"bridge", type:"turn_end" | "flush"}
 *                     {__manglara:"bridge", type:"state", state: AvatarState}
 *                     {__manglara:"bridge", type:"cam", enabled: boolean}
 *                     {__manglara:"bridge", type:"ack"}   (one per frame drawn)
 *
 * Frames go as ImageBitmaps rather than a MediaStream: ImageBitmap is
 * transferable across origins via window.postMessage, which a MediaStream is
 * not, and the parent hands them to the fake camera's canvas.
 */
import type { AvatarState } from "@manglara/shared";

export type BridgeMessage =
  | { type: "pcm"; data: ArrayBuffer }
  | { type: "lip_text"; text: string }
  | { type: "turn_end" }
  | { type: "flush" }
  | { type: "state"; state: AvatarState }
  | { type: "cam"; enabled: boolean }
  | { type: "ack" };

const AVATAR_STATES: readonly AvatarState[] = ["idle", "listening", "thinking", "speaking"];

export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (msg.__manglara !== "bridge") return null;
  switch (msg.type) {
    case "pcm":
      return msg.data instanceof ArrayBuffer ? { type: "pcm", data: msg.data } : null;
    case "lip_text":
      return typeof msg.text === "string" ? { type: "lip_text", text: msg.text } : null;
    case "turn_end":
      return { type: "turn_end" };
    case "flush":
      return { type: "flush" };
    case "state":
      return AVATAR_STATES.includes(msg.state as AvatarState)
        ? { type: "state", state: msg.state as AvatarState }
        : null;
    case "cam":
      return typeof msg.enabled === "boolean" ? { type: "cam", enabled: msg.enabled } : null;
    case "ack":
      return { type: "ack" };
    default:
      return null;
  }
}

export function isEmbedded(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

function postToParent(message: Record<string, unknown>, transfer: Transferable[] = []): void {
  // The avatar image is not sensitive and the parent's origin is the meeting
  // provider's (Teams/Zoom/Meet), which is not known in advance.
  window.parent.postMessage({ __manglara: "avatar", ...message }, "*", transfer);
}

export function announceReady(): void {
  if (isEmbedded()) postToParent({ type: "ready" });
}

/** Frames sent but not yet acknowledged before new ones are dropped. */
const MAX_IN_FLIGHT = 2;
/** Without an ack for this long, assume acks were lost and resync. */
const ACK_TIMEOUT_MS = 1000;

export interface FramePumpOptions {
  /** Mangrove loop drawn behind the avatar (cover-fit). */
  background?: HTMLVideoElement | null;
  size?: { width: number; height: number };
  /** Called for every frame produced (FPS counter). */
  onFrame?: () => void;
}

export interface FramePump {
  /** Turn the WebGL canvas, right after a render, into one finished frame. */
  push(canvas: HTMLCanvasElement): void;
  /** The parent drew a frame. */
  ack(): void;
  stop(): void;
}

/**
 * Turns rendered avatar frames into finished camera frames for the parent:
 * the mangrove background (cover) or, until it can play, the brand gradient,
 * with the avatar on top (contain). Called from the render loop, so each
 * rendered frame is copied exactly once and the camera runs at the render rate
 * - no `captureStream` + <video> detour, no second timer.
 *
 * Flow control: once the parent proves it acknowledges frames, at most
 * MAX_IN_FLIGHT go unacknowledged; a busy meeting page then gets fewer frames
 * instead of a growing queue (video falling ever further behind).
 */
export function createFramePump(options: FramePumpOptions = {}): FramePump {
  const { background = null, size = { width: 640, height: 480 }, onFrame } = options;
  const { width: W, height: H } = size;
  const embedded = isEmbedded();

  // OffscreenCanvas hands its frame over with transferToImageBitmap (no copy).
  // Without it (old Safari, standalone preview only) fall back to a canvas.
  const offscreen = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : null;
  const composite: OffscreenCanvas | HTMLCanvasElement =
    offscreen ?? Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = composite.getContext("2d", { alpha: false }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;

  let gradient: CanvasGradient | null = null;
  let stopped = false;
  let acksSeen = false;
  let inFlight = 0;
  let lastSentAt = 0;

  const paintBackground = () => {
    if (!ctx) return;
    if (background && background.readyState >= 2 && background.videoWidth) {
      const bs = Math.max(W / background.videoWidth, H / background.videoHeight);
      const bw = background.videoWidth * bs;
      const bh = background.videoHeight * bs;
      ctx.drawImage(background, (W - bw) / 2, (H - bh) / 2, bw, bh);
      return;
    }
    if (!gradient) {
      gradient = ctx.createLinearGradient(0, 0, W, H);
      gradient.addColorStop(0, "#0c2b26");
      gradient.addColorStop(1, "#1d5c4d");
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
  };

  const send = (bitmap: ImageBitmap) => {
    if (stopped || !embedded) {
      bitmap.close();
      return;
    }
    postToParent({ type: "frame", bitmap }, [bitmap]);
    inFlight += 1;
    lastSentAt = performance.now();
  };

  return {
    push(canvas) {
      if (stopped || !ctx || !canvas.width || !canvas.height) return;
      if (acksSeen && inFlight >= MAX_IN_FLIGHT) {
        if (performance.now() - lastSentAt < ACK_TIMEOUT_MS) return; // drop
        inFlight = 0;
      }
      paintBackground();
      const s = Math.min(W / canvas.width, H / canvas.height);
      const aw = canvas.width * s;
      const ah = canvas.height * s;
      ctx.drawImage(canvas, (W - aw) / 2, (H - ah) / 2, aw, ah);
      onFrame?.();
      if (offscreen) {
        send(offscreen.transferToImageBitmap());
      } else {
        createImageBitmap(composite).then(send).catch(() => {});
      }
    },
    ack() {
      if (!acksSeen) {
        acksSeen = true;
        inFlight = 0;
        return;
      }
      inFlight = Math.max(0, inFlight - 1);
    },
    stop() {
      stopped = true;
    },
  };
}
