/**
 * Client for "Live Meeting con Manglara": REST commands + event WebSocket.
 *
 * The UI never talks to the meeting browser directly: it asks the backend to
 * join/leave, toggle the bot's mic/cam and switch Gemini on/off, and listens to
 * `/ws/meetings/{id}` for state and transcripts.
 */
import { backendHttpOrigin, backendWsOrigin } from "./backend-url";

export type MeetingProvider = "teams" | "zoom" | "meet";

export type BridgeState =
  | "idle"
  | "launching"
  | "joining"
  | "lobby"
  | "in_meeting"
  | "leaving"
  | "closed"
  | "error";

export type BrainState = "off" | "starting" | "active" | "stopping";

export type MeetingTranscriptRole = "participant" | "manglara";

export interface MeetingState {
  id: string;
  provider: MeetingProvider;
  name: string;
  bridge: BridgeState;
  brain: BrainState;
  mic_enabled: boolean;
  cam_enabled: boolean;
  error: string | null;
}

export type MeetingEvent =
  | ({ type: "state" } & MeetingState)
  | { type: "transcript"; role: MeetingTranscriptRole; text: string }
  | { type: "error"; message: string };

const BRIDGE_STATES: readonly BridgeState[] = [
  "idle",
  "launching",
  "joining",
  "lobby",
  "in_meeting",
  "leaving",
  "closed",
  "error",
];
const BRAIN_STATES: readonly BrainState[] = ["off", "starting", "active", "stopping"];
const PROVIDERS: readonly MeetingProvider[] = ["teams", "zoom", "meet"];

/** A bridge in one of these states is done: no more events will arrive. */
export function isTerminal(bridge: BridgeState): boolean {
  return bridge === "closed" || bridge === "error";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Validates a raw state object from the backend (REST or WS). */
export function parseMeetingState(v: unknown): MeetingState | null {
  if (!isObject(v)) return null;
  if (typeof v.id !== "string") return null;
  if (!PROVIDERS.includes(v.provider as MeetingProvider)) return null;
  if (!BRIDGE_STATES.includes(v.bridge as BridgeState)) return null;
  if (!BRAIN_STATES.includes(v.brain as BrainState)) return null;
  return {
    id: v.id,
    provider: v.provider as MeetingProvider,
    name: typeof v.name === "string" ? v.name : "Manglara",
    bridge: v.bridge as BridgeState,
    brain: v.brain as BrainState,
    mic_enabled: v.mic_enabled === true,
    cam_enabled: v.cam_enabled === true,
    error: typeof v.error === "string" && v.error ? v.error : null,
  };
}

/** Parses one WS frame. Unknown or malformed messages yield null. */
export function parseMeetingEvent(raw: string): MeetingEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(msg)) return null;
  switch (msg.type) {
    case "state": {
      const state = parseMeetingState(msg);
      return state ? { type: "state", ...state } : null;
    }
    case "transcript":
      if (
        (msg.role === "participant" || msg.role === "manglara") &&
        typeof msg.text === "string"
      ) {
        return { type: "transcript", role: msg.role, text: msg.text };
      }
      return null;
    case "error":
      return {
        type: "error",
        message: typeof msg.message === "string" ? msg.message : "Error en la reunión",
      };
    default:
      return null;
  }
}

/**
 * Instant provider detection while the user types/pastes, mirroring
 * `server/meeting/detector.py`. The backend has the final word on join.
 */
export function detectProvider(input: string): MeetingProvider | null {
  const text = input.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const looksLikeUrl =
    lower.includes("://") || /^(www\.|teams\.|zoom\.|meet\.)/.test(lower);
  if (looksLikeUrl) {
    if (/(teams\.microsoft\.com|teams\.live\.com)/.test(lower)) return "teams";
    if (/(^|[./])zoom\.(us|com)/.test(lower)) return "zoom";
    if (/meet\.google\.com/.test(lower)) return "meet";
    return null;
  }
  const compact = lower.replace(/[\s-]/g, "");
  if (/^\d{9,11}$/.test(compact)) return "zoom";
  if (/^[a-z]{3}[a-z]{4}[a-z]{3}$/.test(compact)) return "meet";
  return null;
}

export class MeetingApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "MeetingApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${backendHttpOrigin()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new MeetingApiError("No se pudo contactar al servidor", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = isObject(body) ? body.detail : null;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? "Datos inválidos"
          : `Error del servidor (${res.status})`;
    throw new MeetingApiError(message, res.status);
  }
  return body as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const meetingApi = {
  async join(input: string, name?: string): Promise<MeetingState> {
    const raw = await post<unknown>("/meetings/join", { input, name: name || null });
    const state = parseMeetingState(raw);
    if (!state) throw new MeetingApiError("Respuesta inválida del servidor", 500);
    return state;
  },
  async get(id: string): Promise<MeetingState | null> {
    try {
      return parseMeetingState(await request<unknown>(`/meetings/${encodeURIComponent(id)}`));
    } catch (err) {
      if (err instanceof MeetingApiError && err.status === 404) return null;
      throw err;
    }
  },
  leave: (id: string) => post<{ ok: boolean }>(`/meetings/${encodeURIComponent(id)}/leave`),
  startBrain: (id: string) =>
    post<{ ok: boolean }>(`/meetings/${encodeURIComponent(id)}/brain/start`),
  stopBrain: (id: string) =>
    post<{ ok: boolean }>(`/meetings/${encodeURIComponent(id)}/brain/stop`),
  setMic: (id: string, enabled: boolean) =>
    post<{ ok: boolean }>(`/meetings/${encodeURIComponent(id)}/mic`, { enabled }),
  setCam: (id: string, enabled: boolean) =>
    post<{ ok: boolean }>(`/meetings/${encodeURIComponent(id)}/cam`, { enabled }),
};

export interface MeetingEventsHandlers {
  onEvent: (event: MeetingEvent) => void;
  /** Socket state, for a "reconnecting" hint in the UI. */
  onConnectionChange?: (connected: boolean) => void;
}

/**
 * Subscription to `/ws/meetings/{id}` with automatic reconnection (exponential
 * backoff) until `close()` or the meeting reaches a terminal state.
 */
export class MeetingEvents {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly baseDelayMs = 1000;
  private readonly maxDelayMs = 10000;

  constructor(
    private readonly id: string,
    private readonly handlers: MeetingEventsHandlers
  ) {
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const ws = new WebSocket(
      `${backendWsOrigin()}/ws/meetings/${encodeURIComponent(this.id)}`
    );
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.handlers.onConnectionChange?.(true);
    };
    ws.onmessage = (ev) => {
      const event = parseMeetingEvent(String(ev.data));
      if (!event) return;
      this.handlers.onEvent(event);
      if (event.type === "state" && isTerminal(event.bridge)) this.close();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      this.handlers.onConnectionChange?.(false);
      // 4404: the backend no longer knows this meeting (e.g. server restart).
      if (ev.code === 4404) {
        this.handlers.onEvent({ type: "error", message: "La reunión ya no existe en el servidor" });
        this.closed = true;
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    this.attempts += 1;
    const delay = Math.min(this.baseDelayMs * 2 ** (this.attempts - 1), this.maxDelayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }
}
