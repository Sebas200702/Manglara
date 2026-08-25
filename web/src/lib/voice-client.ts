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

function wsUrl(path = "/ws/voice"): string {
  return `${backendWsOrigin()}${path}`;
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
  /** Give up after this many attempts; the user must re-initiate then. */
  private readonly maxReconnectAttempts = 6;
  /** Exponential backoff base, ms. */
  private readonly reconnectBaseMs = 1000;
  private readonly reconnectMaxDelayMs = 15000;
  /** Clears the "Reconectado" notice after a moment. */
  private reconnectedNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: VoiceClientCallbacks = {}) {
    this.callbacks = callbacks;
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

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());

      ws.onopen = () => {
        this.ws = ws;
        this.callbacks.onConnectionChange?.("connected");
        resolve();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerToClientMessage;
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
        this.callbacks.onConnectionChange?.("error");
        this.callbacks.onError?.("WebSocket connection failed");
        reject(new Error("WebSocket connection failed"));
      };

      ws.onclose = () => {
        this.ws = null;
        if (this.intentionalClose) {
          this.callbacks.onConnectionChange?.("disconnected");
          return;
        }
        // Unexpected drop. Stay in the call and try to restore the link.
        this.callbacks.onConnectionChange?.("disconnected");
        if (this.active) this.scheduleReconnect();
      };
    });
  }

  /**
   * Re-open the socket and resume the media pipelines after an unexpected drop.
   * The mic/video worklets already read `this.ws` dynamically, so once a new
   * socket is OPEN they resume sending with no further wiring.
   */
  private async reconnect(): Promise<void> {
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

  /** Queue the next reconnection attempt with exponential backoff. Idempotent. */
  private scheduleReconnect(): void {
    if (this.reconnecting || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.callbacks.onError?.("No se pudo restablecer la conexión");
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    this.callbacks.onReconnecting?.(this.reconnectAttempts);
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** (this.reconnectAttempts - 1),
      this.reconnectMaxDelayMs
    );
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
