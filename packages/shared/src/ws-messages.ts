export type TranscriptRole = "user" | "model";

export type ClientToServerMessage =
  | { type: "audio"; data: string }
  | { type: "video"; data: string; mimeType: string }
  /** Keepalive. Answered with `pong`; see the heartbeat notes below. */
  | { type: "ping" }
  | { type: "pong" };

export type ServerToClientMessage =
  | { type: "audio"; data: string }
  | { type: "transcript"; role: TranscriptRole; text: string }
  | { type: "turn_complete" }
  /** Barge-in: the user spoke over the model, so Gemini abandoned the rest of
   *  the turn. Any audio already sent ahead of playback is stale. */
  | { type: "interrupted" }
  | { type: "session_ready" }
  /**
   * Application-level heartbeat, both directions.
   *
   * The socket can go half-open - a laptop lid closes, wifi switches, a proxy
   * silently reaps an idle tunnel - and TCP will not tell either side: no
   * `close` frame ever arrives, so both keep a dead socket open forever. The
   * only reliable detector is traffic that must be answered. Each side pings on
   * an interval and treats a long silence as a drop.
   *
   * It doubles as anti-idle: platform proxies (Render, nginx) close tunnels
   * with no bytes for ~60 s, which happens whenever nobody is talking.
   */
  | { type: "ping" }
  | { type: "pong" }
  | { type: "error"; message: string };

export type AvatarState = "idle" | "listening" | "thinking" | "speaking";

export function isClientMessage(
  data: unknown
): data is ClientToServerMessage {
  if (typeof data !== "object" || data === null || !("type" in data)) {
    return false;
  }
  const msg = data as Record<string, unknown>;
  if (msg.type === "audio") {
    return typeof msg.data === "string";
  }
  if (msg.type === "video") {
    return typeof msg.data === "string" && typeof msg.mimeType === "string";
  }
  if (msg.type === "ping" || msg.type === "pong") {
    return true;
  }
  return false;
}
