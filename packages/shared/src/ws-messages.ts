export type TranscriptRole = "user" | "model";

export type ClientToServerMessage =
  | { type: "audio"; data: string }
  | { type: "video"; data: string; mimeType: string };

export type ServerToClientMessage =
  | { type: "audio"; data: string }
  | { type: "transcript"; role: TranscriptRole; text: string }
  | { type: "turn_complete" }
  /** Barge-in: the user spoke over the model, so Gemini abandoned the rest of
   *  the turn. Any audio already sent ahead of playback is stale. */
  | { type: "interrupted" }
  | { type: "session_ready" }
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
  return false;
}
