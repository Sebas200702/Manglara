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
 *
 * Frames go as ImageBitmaps rather than a MediaStream: ImageBitmap is
 * transferable across origins via window.postMessage, which a MediaStream is
 * not, and the parent paints them onto the fake camera's canvas.
 */
import type { AvatarState } from "@manglara/shared";

export type BridgeMessage =
  | { type: "pcm"; data: ArrayBuffer }
  | { type: "lip_text"; text: string }
  | { type: "turn_end" }
  | { type: "flush" }
  | { type: "state"; state: AvatarState };

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

/**
 * Streams the avatar canvas to the parent as ImageBitmaps at `fps`.
 *
 * The WebGL canvas is read through `captureStream()` + a <video>, which works
 * regardless of `preserveDrawingBuffer` (TalkingHead does not set it, so a
 * direct `createImageBitmap(canvas)` could read a cleared buffer).
 * Returns a stop function.
 */
export function startFramePump(
  canvas: HTMLCanvasElement,
  fps: number,
  onFrame?: () => void
): () => void {
  const stream = canvas.captureStream(fps);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  void video.play().catch(() => {});

  let stopped = false;
  let inFlight = false;
  const interval = 1000 / fps;

  const tick = () => {
    if (stopped || inFlight || video.readyState < 2 || !video.videoWidth) return;
    inFlight = true;
    createImageBitmap(video)
      .then((bitmap) => {
        if (stopped) {
          bitmap.close();
          return;
        }
        if (isEmbedded()) postToParent({ type: "frame", bitmap }, [bitmap]);
        else bitmap.close();
        onFrame?.();
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(tick, interval);

  return () => {
    stopped = true;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}
