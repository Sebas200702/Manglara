import type {
  ClientToServerMessage,
  ServerToClientMessage,
  TranscriptRole,
} from "@manglara/shared";
import { AudioPlaybackQueue } from "./audio-playback-queue.js";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface VoiceClientCallbacks {
  onConnectionChange?: (state: ConnectionState) => void;
  onTranscript?: (role: TranscriptRole, text: string) => void;
  onTurnComplete?: () => void;
  /** Barge-in: everything streamed ahead of playback is stale, drop it. */
  onInterrupted?: () => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onSessionReady?: () => void;
  onError?: (message: string) => void;
  onVideoStream?: (stream: MediaStream | null) => void;
  /** The live connection dropped; an automatic reconnection attempt is starting. */
  onReconnecting?: (attempt: number) => void;
  /** The connection was successfully restored after a drop. */
  onReconnected?: () => void;
}

function workletBlobUrl(): string {
  const code = `const T=16000,F=Math.floor(T*30/1e3);class MicProcessor extends AudioWorkletProcessor{resampled=[];accumulator=0;process(e){const t=e[0]?.[0];if(!t?.length)return!0;const r=T/sampleRate;for(let o=0;o<t.length;o++)if(this.accumulator+=r,this.accumulator>=1){this.accumulator-=1;const a=Math.max(-1,Math.min(1,t[o]));this.resampled.push(a)}for(;this.resampled.length>=F;){const o=this.resampled.splice(0,F),a=new Int16Array(o.length);for(let s=0;s<o.length;s++)a[s]=o[s]<0?32768*o[s]:32767*o[s];this.port.postMessage(a.buffer,[a.buffer])}return!0}}registerProcessor("mic-processor",MicProcessor);`;
  return URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Base64 for the small mic chunks (1920 bytes each). Fine synchronously at that
 * size; video frames are tens of kilobytes and use `blobToBase64` instead.
 */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Base64 of a Blob, encoded OFF the main thread.
 *
 * The previous path read the blob into an ArrayBuffer and ran the synchronous
 * `String.fromCharCode(...)` + `btoa` loop above over a whole JPEG. That is one of
 * the main-thread stalls that made the avatar's animation hitch - and a hitch
 * freezes the mouth mid-word, which reads as lip-sync drift however good the
 * playback clock is. FileReader does the same work without blocking the render loop.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Worker that JPEG-encodes and base64s a captured frame, entirely off the main
 * thread.
 *
 * Measured on the dev machine, per frame: `canvas.toDataURL` blocked the main thread
 * for 21.8 ms median / 70.0 ms max and the synchronous base64 loop for another
 * 13.4 ms - and even `canvas.toBlob`, despite the async callback, blocked for 9.6 ms
 * median / 63.5 ms max because the canvas readback is synchronous. TalkingHead's
 * animation loop reports a delta clamped at 66.7 ms, so a stall like that both drops
 * frames (the mouth freezes mid-word) and used to lose that time from the lip-sync
 * clock permanently.
 *
 * Handing an ImageBitmap to a worker instead costs 0.5 ms to create and 0.6 ms to
 * transfer - the transfer is zero-copy - and the ~75 ms encode happens where it
 * cannot touch the render loop.
 */
function frameWorkerBlobUrl(): string {
  const code = `self.onmessage=async(e)=>{const b=e.data;try{const c=new OffscreenCanvas(b.width,b.height);c.getContext("2d").drawImage(b,0,0);b.close();const bl=await c.convertToBlob({type:"image/jpeg",quality:0.85});const u=new Uint8Array(await bl.arrayBuffer());let s="";const k=0x8000;for(let i=0;i<u.length;i+=k)s+=String.fromCharCode.apply(null,u.subarray(i,i+k));self.postMessage(btoa(s));}catch(err){try{b.close();}catch(_){}self.postMessage(null);}};`;
  return URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
}

/**
 * Origin of the voice backend for the WebSocket. Configurable via the Vite env
 * var `VITE_BACKEND_URL` so a single codebase can point at any backend (local,
 * staging, prod). Accepts:
 *   - a `ws://` / `wss://` origin  -> used as-is
 *   - an `http://` / `https://` origin -> mapped to `ws` / `wss`
 *   - a bare `host[:port]`         -> scheme derived from the page (wss on https)
 *   - omitted                      -> `localhost:8000` (local-dev default)
 * NOTE: `VITE_*` vars are inlined at build time, so set it before `vite build`
 * (or in the shell/`.env` before `bun run dev`).
 */
function backendWsOrigin(): string {
  const configured = import.meta.env.VITE_BACKEND_URL?.trim();
  const pageProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (!configured) return `${pageProto}//localhost:8000`;
  if (/^wss?:\/\//i.test(configured)) return configured.replace(/\/+$/, "");
  if (/^https:\/\//i.test(configured))
    return `wss://${configured.slice(8).replace(/\/+$/, "")}`;
  if (/^http:\/\//i.test(configured))
    return `ws://${configured.slice(7).replace(/\/+$/, "")}`;
  return `${pageProto}//${configured.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

/**
 * Call id, carried on every socket of a single call - including the ones opened
 * by a reconnect. The backend keys Gemini's resumption handle on it, so a
 * reconnected socket rejoins the same conversation rather than starting a new
 * one. Without it Manglara re-introduced herself after every blip, having
 * forgotten everything said before.
 */
function newCallId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function wsUrl(callId: string | null, path = "/ws/voice"): string {
  const query = callId ? `?session=${encodeURIComponent(callId)}` : "";
  return `${backendWsOrigin()}${path}${query}`;
}

const VIDEO_FRAME_INTERVAL_MS = 1500;
/**
 * Capture size sent to the model. Kept at the previous canvas dimensions, including
 * the 16:9 -> 4:3 squash the old `drawImage` did, so what Gemini sees is unchanged.
 */
const VIDEO_FRAME_WIDTH = 640;
const VIDEO_FRAME_HEIGHT = 480;

/**
 * After Manglara stops speaking, wait this long before reopening the mic. Guards
 * against the tail of her audio (played through external speakers) being captured
 * and echoed back as a new user turn - which is what makes her answer herself in
 * a loop. Also absorbs brief mid-turn playback underruns without reopening.
 */
const MIC_REOPEN_GUARD_MS = 500;

/**
 * Heartbeat. `ws.onclose` is not a reliable drop detector: when a laptop sleeps,
 * wifi switches, or a proxy silently reaps an idle tunnel, the socket goes
 * half-open and no close frame ever arrives - `readyState` stays OPEN on a
 * connection where nothing can get through. Pinging on an interval and treating
 * a long silence as a drop is the only way to notice.
 *
 * The window is deliberately much larger than the interval: the server pings
 * every 20 s and answers ours, so several exchanges must be missed before we
 * declare the socket dead.
 */
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 45000;

/** A socket stuck in CONNECTING may never fire `onerror`; bound the wait. */
const CONNECT_TIMEOUT_MS = 15000;

export class VoiceClient {
  private ws: WebSocket | null = null;
  private micCtx: AudioContext | null = null;
  private playbackCtx: AudioContext | null = null;
  private playbackQueue: AudioPlaybackQueue | null = null;
  private micStream: MediaStream | null = null;
  private videoStream: MediaStream | null = null;
  private videoInterval: ReturnType<typeof setInterval> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private frameWorker: Worker | null = null;
  private frameWorkerUrl: string | null = null;
  /** A frame is in the worker; don't queue another behind it. */
  private framePending = false;
  private micEnabled = true;
  /**
   * Half-duplex gate: true while Manglara is speaking, so her voice isn't fed
   * back into the model. Separate from `micEnabled`, the user's manual mute.
   */
  private micSuppressed = false;
  private micReopenTimer: ReturnType<typeof setTimeout> | null = null;
  private cameraEnabled = true;
  private callbacks: VoiceClientCallbacks;
  private audioChunkSink: ((pcm: ArrayBuffer) => void) | null = null;

  /**
   * True while a call is live (started and not yet hung up). Gates auto-reconnect:
   * an unexpected drop only auto-reconnects while the call is supposed to be up,
   * so a failed *initial* connect surfaces as an error instead of a reconnect loop.
   */
  private active = false;
  /** Set by `disconnect()` so the resulting `onclose` is not treated as a drop. */
  private intentionalClose = false;
  /** A reconnect attempt is scheduled/in flight. */
  private reconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Exponential backoff base, ms. */
  private readonly reconnectBaseMs = 1000;
  private readonly reconnectMaxDelayMs = 15000;
  /** Clears the "Reconectado" notice after a moment. */
  private reconnectedNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Instance-level so tests can shrink them; see the constants above. */
  private readonly heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
  private readonly heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS;
  /** Timestamp of the last frame from the server; drives the watchdog. */
  private lastServerMessageAt = 0;
  /** Bound listeners for network/wake events, kept so they can be removed. */
  private wakeListener: (() => void) | null = null;
  /** Stable for the whole call; see `newCallId`. Reset by `disconnect()`. */
  private callId: string | null = null;

  constructor(callbacks: VoiceClientCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /**
   * Coming back from sleep or a network switch, the browser fires `online` /
   * `visibilitychange` long before a backoff timer would have elapsed - and the
   * old socket is usually half-open, so nothing else will notice at all. Retry
   * at once on those events instead of waiting out the delay.
   */
  private installWakeListeners(): void {
    if (this.wakeListener || typeof window === "undefined") return;
    if (typeof window.addEventListener !== "function") return;
    const onWake = () => {
      if (!this.active || this.intentionalClose) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (this.isConnected) {
        // Might be a zombie: force the heartbeat check rather than trusting
        // `readyState`, which stays OPEN on a half-open socket.
        this.checkHeartbeat();
        return;
      }
      // Skip the remaining backoff and try now.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        this.reconnecting = false;
      }
      if (!this.reconnecting) this.scheduleReconnect(0);
    };
    this.wakeListener = onWake;
    window.addEventListener("online", onWake);
    window.addEventListener("focus", onWake);
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", onWake);
    }
  }

  private removeWakeListeners(): void {
    const onWake = this.wakeListener;
    if (!onWake || typeof window === "undefined") return;
    if (typeof window.removeEventListener === "function") {
      window.removeEventListener("online", onWake);
      window.removeEventListener("focus", onWake);
    }
    if (typeof document !== "undefined" && document.removeEventListener) {
      document.removeEventListener("visibilitychange", onWake);
    }
    this.wakeListener = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastServerMessageAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" } satisfies ClientToServerMessage));
        } catch {
          // A send that throws on an OPEN socket means it is already dead.
        }
      }
      this.checkHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Declare a silent socket dead. `close()` synthesises the `onclose` that a
   * half-open connection never delivers, which is what kicks off the reconnect.
   */
  private checkHeartbeat(): void {
    if (!this.active || this.intentionalClose) return;
    if (Date.now() - this.lastServerMessageAt < this.heartbeatTimeoutMs) return;
    const ws = this.ws;
    if (!ws) {
      if (!this.reconnecting) this.scheduleReconnect();
      return;
    }
    console.warn("[voice] sin respuesta del servidor, reiniciando la conexión");
    this.ws = null;
    // Detach first: this close is ours, and the handler would otherwise treat
    // it as an unexpected drop *and* race with the reconnect we start here.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
    this.callbacks.onConnectionChange?.("connecting");
    if (!this.reconnecting) this.scheduleReconnect(0);
  }

  /**
   * Redirects assistant PCM (24 kHz, 16-bit LE) to an external consumer
   * (the TalkingHead avatar) instead of the built-in playback queue. Pass
   * null to fall back to local playback. Speaking state is then owned by the
   * consumer rather than the playback queue.
   */
  setAudioChunkSink(sink: ((pcm: ArrayBuffer) => void) | null): void {
    this.audioChunkSink = sink;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Flag the call as live once it is fully up. Until this is set, an unexpected
   * close is treated as a failed *initial* connect (an error), not a drop that
   * should auto-reconnect. `disconnect()` clears it again.
   */
  markActive(): void {
    this.active = true;
  }

  getVideoCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    // A fresh connect is never an intentional close until disconnect() says so.
    this.intentionalClose = false;

    this.callbacks.onConnectionChange?.("connecting");
    this.installWakeListeners();
    // Minted once per call, kept across reconnects.
    this.callId ??= newCallId();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(this.callId));
      // Guards the promise: after the socket opens, a later error must not
      // reject (already settled) nor be reported as a failed connect - it is a
      // mid-call drop, which `onclose` handles by reconnecting silently.
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // nothing to do
        }
        reject(new Error("WebSocket connection timed out"));
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.startHeartbeat();
        this.callbacks.onConnectionChange?.("connected");
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.onmessage = (event) => {
        // Any frame is proof of life, whatever it carries.
        this.lastServerMessageAt = Date.now();
        try {
          const msg = JSON.parse(event.data as string) as ServerToClientMessage;
          if (msg.type === "ping") {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "pong" } satisfies ClientToServerMessage));
            }
            return;
          }
          if (msg.type === "pong") return;
          // Deliberately NOT logged per message: audio arrives continuously and a
          // console.log per chunk is itself a main-thread stall (worse with DevTools
          // open), which hitches the avatar's render loop. Use `__lipsyncLog()` for
          // timing questions - it samples at 4 Hz instead.
          this.handleMessage(msg);
        } catch {
          this.callbacks.onError?.("Invalid server message");
        }
      };

      ws.onerror = () => {
        if (settled) return; // mid-call drop; onclose reconnects quietly
        settled = true;
        clearTimeout(timeout);
        this.callbacks.onConnectionChange?.("error");
        reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        if (this.ws === ws) this.ws = null;
        if (this.intentionalClose) {
          this.stopHeartbeat();
          this.callbacks.onConnectionChange?.("disconnected");
          return;
        }
        if (this.active) {
          // Unexpected drop mid-call. Report "connecting", not "disconnected":
          // the call is still up as far as the user is concerned, and the state
          // feeds the avatar's mood - flashing to idle on every blip is worse
          // than showing a reconnect in progress.
          this.callbacks.onConnectionChange?.("connecting");
          this.scheduleReconnect();
        } else {
          this.stopHeartbeat();
          this.callbacks.onConnectionChange?.("disconnected");
        }
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket closed before opening"));
        }
      };
    });
  }

  /**
   * Re-open the socket and resume the media pipelines after an unexpected drop.
   * The mic/video worklets already read `this.ws` dynamically, so once a new
   * socket is OPEN they resume sending with no further wiring.
   */
  private async reconnect(): Promise<void> {
    if (!this.active || this.intentionalClose) {
      this.reconnecting = false;
      return;
    }
    try {
      await this.connect();
      await this.startMic();
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.callbacks.onReconnected?.();
    } catch {
      // `scheduleReconnect()` is guarded while this attempt is in flight. Clear
      // that guard before queuing the next attempt, otherwise one failed retry
      // leaves the call permanently disconnected.
      this.reconnecting = false;
      if (this.active) this.scheduleReconnect();
    }
  }

  /**
   * Queue the next reconnection attempt with exponential backoff. Idempotent.
   *
   * There is deliberately no attempt cap: the call is only ever given up on by
   * `disconnect()`. A cap meant a long tunnel ride or an overnight laptop sleep
   * left the kiosk permanently dead with no way back short of a page reload.
   * The delay is capped instead, so a long outage costs one retry every
   * `reconnectMaxDelayMs` and heals the moment the network returns.
   */
  private scheduleReconnect(delayOverrideMs?: number): void {
    if (this.reconnecting || this.reconnectTimer) return;
    if (!this.active || this.intentionalClose) return;
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    this.callbacks.onReconnecting?.(this.reconnectAttempts);
    const backoff = Math.min(
      this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1),
      this.reconnectMaxDelayMs
    );
    // Jitter keeps a roomful of kiosks from retrying in lockstep after a
    // backend restart and knocking it straight back over.
    const delay =
      delayOverrideMs ?? backoff + Math.random() * Math.min(backoff, 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private handleMessage(msg: ServerToClientMessage): void {
    switch (msg.type) {
      case "audio":
        if (this.micCtx && this.micCtx.state === "suspended") {
          void this.micCtx.resume();
        }
        if (this.playbackCtx && this.playbackCtx.state === "suspended") {
          void this.playbackCtx.resume();
        }
        if (this.audioChunkSink) {
          this.audioChunkSink(base64ToArrayBuffer(msg.data));
        } else {
          this.playbackQueue?.enqueue(msg.data, (speaking) =>
            this.callbacks.onSpeakingChange?.(speaking)
          );
        }
        break;
      case "transcript":
        this.callbacks.onTranscript?.(msg.role, msg.text);
        break;
      case "turn_complete":
        this.callbacks.onTurnComplete?.();
        break;
      case "interrupted":
        // Drop the audio we were sent ahead of playback - Gemini abandoned it.
        this.playbackQueue?.stop();
        this.callbacks.onInterrupted?.();
        break;
      case "session_ready":
        this.callbacks.onSessionReady?.();
        break;
      case "error":
        this.callbacks.onError?.(msg.message);
        break;
    }
  }

  async startMic(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    // Already initialised (e.g. after a reconnect): just make sure the audio
    // contexts are running again and resume the existing pipelines.
    if (this.micStream) {
      await this.playbackCtx?.resume().catch(() => {});
      await this.micCtx?.resume().catch(() => {});
      this.active = true;
      return;
    }

    this.micCtx = new AudioContext({ sampleRate: 16000 });
    this.playbackCtx = new AudioContext({ sampleRate: 24000 });
    this.playbackQueue = new AudioPlaybackQueue(this.playbackCtx);

    await this.playbackCtx.resume();
    await this.micCtx.resume();

    await this.micCtx.audioWorklet.addModule(workletBlobUrl());
    console.log("[voice] AudioWorklet loaded, context rate:", this.micCtx.sampleRate);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
    });
    console.log("[voice] getUserMedia OK, audio track:", !!stream.getAudioTracks()[0]);

    this.micStream = stream;

    const audioTrack = stream.getAudioTracks()[0];
    const audioOnly = new MediaStream([audioTrack]);
    const source = this.micCtx.createMediaStreamSource(audioOnly);
    const worklet = new AudioWorkletNode(this.micCtx, "mic-processor");
    source.connect(worklet);

    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        console.warn("[voice] ws not open, dropping audio chunk");
        return;
      }
      // While Manglara is speaking, don't forward mic audio: with an external
      // speaker her own voice gets captured and echoed back to the model, so she
      // hears herself and replies in a loop. Reopens shortly after she finishes.
      if (this.micSuppressed) return;
      const payload: ClientToServerMessage = {
        type: "audio",
        data: bufferToBase64(event.data),
      };
      // No per-chunk log here either: this fires every 30 ms for the whole call.
      this.ws.send(JSON.stringify(payload));
    };

    this.startVideo(stream);
    this.active = true;
    console.log("[voice] mic started, sending audio chunks to server");
  }

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = enabled;
    const track = this.micStream?.getAudioTracks()[0];
    if (track) track.enabled = enabled;
  }

  /**
   * Half-duplex gate driven by Manglara's speaking state. While suppressed, mic
   * audio is dropped instead of sent, so her voice over external speakers can't
   * be transcribed back into a self-reply loop. On release, the mic reopens only
   * after a short guard delay to let the audio tail die out. Independent of the
   * manual mute: `setMicEnabled` still governs the user's own on/off.
   */
  setInputSuppressed(suppressed: boolean): void {
    if (this.micReopenTimer) {
      clearTimeout(this.micReopenTimer);
      this.micReopenTimer = null;
    }
    if (suppressed) {
      this.micSuppressed = true;
    } else {
      this.micReopenTimer = setTimeout(() => {
        this.micSuppressed = false;
        this.micReopenTimer = null;
      }, MIC_REOPEN_GUARD_MS);
    }
  }

  setCameraEnabled(enabled: boolean): void {
    this.cameraEnabled = enabled;
    const track = this.micStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = enabled;
    if (enabled) {
      this.startVideoCapture();
    } else {
      this.stopVideoCapture();
    }
  }

  isMicEnabled(): boolean {
    return this.micEnabled;
  }

  isCameraEnabled(): boolean {
    return this.cameraEnabled;
  }

  private startVideo(stream: MediaStream): void {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    this.videoStream = new MediaStream([videoTrack]);
    this.callbacks.onVideoStream?.(this.videoStream);

    // Only the OffscreenCanvas-less fallback path draws into this.
    this.canvas = document.createElement("canvas");
    this.canvas.width = VIDEO_FRAME_WIDTH;
    this.canvas.height = VIDEO_FRAME_HEIGHT;
    this.videoEl = document.createElement("video");
    this.videoEl.srcObject = this.videoStream;
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;

    this.videoEl.play().then(() => {
      if (!this.videoEl) return;
      this.startVideoCapture();
    }).catch(() => {});
  }

  private startVideoCapture(): void {
    if (this.videoInterval || !this.cameraEnabled) return;

    const video = this.videoEl;
    if (!video) return;

    this.ensureFrameWorker();

    this.videoInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (!this.cameraEnabled) return;
      if (video.readyState < video.HAVE_CURRENT_DATA) return;

      if (this.frameWorker) this.captureViaWorker(video);
      else this.captureOnMainThread(video);
    }, VIDEO_FRAME_INTERVAL_MS);
  }

  /** Spin up the encoder worker, unless the browser can't run one. */
  private ensureFrameWorker(): void {
    if (this.frameWorker) return;
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
      console.warn("[voice] sin OffscreenCanvas: los frames se codifican en el hilo principal");
      return;
    }
    try {
      const url = frameWorkerBlobUrl();
      const worker = new Worker(url);
      worker.onmessage = (event: MessageEvent<string | null>) => {
        this.framePending = false;
        const data = event.data;
        if (!data) return;
        if (this.ws?.readyState !== WebSocket.OPEN || !this.cameraEnabled) return;
        const payload: ClientToServerMessage = {
          type: "video",
          data,
          mimeType: "image/jpeg",
        };
        this.ws.send(JSON.stringify(payload));
      };
      worker.onerror = () => {
        this.framePending = false;
      };
      this.frameWorker = worker;
      this.frameWorkerUrl = url;
    } catch {
      // fall back to the main-thread path
    }
  }

  /**
   * Grab a frame as an ImageBitmap and hand it to the worker. `resizeWidth/Height`
   * means even the downscale happens off the main thread, so no canvas is touched
   * here at all.
   */
  private captureViaWorker(video: HTMLVideoElement): void {
    const worker = this.frameWorker;
    if (!worker || this.framePending) return;
    this.framePending = true;
    createImageBitmap(video, {
      resizeWidth: VIDEO_FRAME_WIDTH,
      resizeHeight: VIDEO_FRAME_HEIGHT,
      resizeQuality: "medium",
    })
      .then((bitmap) => {
        if (!this.frameWorker) {
          bitmap.close();
          this.framePending = false;
          return;
        }
        this.frameWorker.postMessage(bitmap, [bitmap]);
      })
      .catch(() => {
        this.framePending = false;
      });
  }

  /** Fallback for browsers without OffscreenCanvas. Blocks the main thread. */
  private captureOnMainThread(video: HTMLVideoElement): void {
    const canvas = this.canvas;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        blobToBase64(blob)
          .then((data) => {
            if (this.ws?.readyState !== WebSocket.OPEN) return;
            const payload: ClientToServerMessage = {
              type: "video",
              data,
              mimeType: "image/jpeg",
            };
            this.ws.send(JSON.stringify(payload));
          })
          .catch(() => {
            // a dropped frame is not worth surfacing; the next one is 1.5 s away
          });
      },
      "image/jpeg",
      0.85
    );
  }

  private stopVideoCapture(): void {
    if (this.videoInterval) {
      clearInterval(this.videoInterval);
      this.videoInterval = null;
    }
  }

  disconnect(): void {
    // Any close from here on is intentional: don't auto-reconnect.
    this.intentionalClose = true;
    this.active = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectedNoticeTimer) {
      clearTimeout(this.reconnectedNoticeTimer);
      this.reconnectedNoticeTimer = null;
    }
    this.stopHeartbeat();
    this.removeWakeListeners();
    // Hanging up ends the conversation: the next call must start fresh, with
    // Manglara introducing herself again.
    this.callId = null;
    this.playbackQueue?.stop();
    this.stopVideoCapture();
    this.frameWorker?.terminate();
    this.frameWorker = null;
    if (this.frameWorkerUrl) {
      URL.revokeObjectURL(this.frameWorkerUrl);
      this.frameWorkerUrl = null;
    }
    this.framePending = false;
    if (this.micReopenTimer) {
      clearTimeout(this.micReopenTimer);
      this.micReopenTimer = null;
    }
    this.micSuppressed = false;
    this.micEnabled = true;
    this.cameraEnabled = true;

    this.videoEl?.pause();
    this.videoEl = null;
    this.canvas = null;

    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.videoStream = null;

    void this.micCtx?.close();
    void this.playbackCtx?.close();
    this.micCtx = null;
    this.playbackCtx = null;
    this.playbackQueue = null;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.callbacks.onVideoStream?.(null);
    this.callbacks.onConnectionChange?.("disconnected");
  }
}
