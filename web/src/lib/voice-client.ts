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
  onSpeakingChange?: (speaking: boolean) => void;
  onSessionReady?: () => void;
  onError?: (message: string) => void;
  onVideoStream?: (stream: MediaStream | null) => void;
  onVideoFrame?: (canvas: HTMLCanvasElement) => void;
}

function workletBlobUrl(): string {
  const code = `const T=16000,F=Math.floor(T*30/1e3);class MicProcessor extends AudioWorkletProcessor{resampled=[];accumulator=0;process(e){const t=e[0]?.[0];if(!t?.length)return!0;const r=T/sampleRate;for(let o=0;o<t.length;o++)if(this.accumulator+=r,this.accumulator>=1){this.accumulator-=1;const a=Math.max(-1,Math.min(1,t[o]));this.resampled.push(a)}for(;this.resampled.length>=F;){const o=this.resampled.splice(0,F),a=new Int16Array(o.length);for(let s=0;s<o.length;s++)a[s]=o[s]<0?32768*o[s]:32767*o[s];this.port.postMessage(a.buffer,[a.buffer])}return!0}}registerProcessor("mic-processor",MicProcessor);`;
  return URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
}

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

function wsUrl(path = "/ws/voice"): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//localhost:3000${path}`;
}

const VIDEO_FRAME_INTERVAL_MS = 1500;

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
  private callbacks: VoiceClientCallbacks;

  constructor(callbacks: VoiceClientCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getVideoCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

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
        this.callbacks.onConnectionChange?.("disconnected");
      };
    });
  }

  private handleMessage(msg: ServerToClientMessage): void {
    switch (msg.type) {
      case "audio":
        this.playbackQueue?.enqueue(msg.data, (speaking) =>
          this.callbacks.onSpeakingChange?.(speaking)
        );
        break;
      case "transcript":
        this.callbacks.onTranscript?.(msg.role, msg.text);
        break;
      case "turn_complete":
        this.callbacks.onTurnComplete?.();
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

    this.micCtx = new AudioContext({ sampleRate: 16000 });
    this.playbackCtx = new AudioContext({ sampleRate: 24000 });
    this.playbackQueue = new AudioPlaybackQueue(this.playbackCtx);

    await this.playbackCtx.resume();
    await this.micCtx.resume();

    await this.micCtx.audioWorklet.addModule(workletBlobUrl());

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

    this.micStream = stream;

    const audioTrack = stream.getAudioTracks()[0];
    const audioOnly = new MediaStream([audioTrack]);
    const source = this.micCtx.createMediaStreamSource(audioOnly);
    const worklet = new AudioWorkletNode(this.micCtx, "mic-processor");
    source.connect(worklet);

    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const payload: ClientToServerMessage = {
        type: "audio",
        data: bufferToBase64(event.data),
      };
      this.ws.send(JSON.stringify(payload));
    };

    this.startVideo(stream);
  }

  private startVideo(stream: MediaStream): void {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return;

    this.videoStream = new MediaStream([videoTrack]);
    this.callbacks.onVideoStream?.(this.videoStream);

    this.canvas = document.createElement("canvas");
    this.canvas.width = 640;
    this.canvas.height = 480;
    this.videoEl = document.createElement("video");
    this.videoEl.srcObject = this.videoStream;
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;

    const ctx = this.canvas.getContext("2d");

    this.videoEl.play().then(() => {
      if (!ctx || !this.videoEl || !this.canvas) return;

      this.videoInterval = setInterval(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        if (this.videoEl!.readyState < this.videoEl!.HAVE_CURRENT_DATA) return;

        ctx.drawImage(this.videoEl!, 0, 0, this.canvas!.width, this.canvas!.height);
        
        // Callback for preview
        this.callbacks.onVideoFrame?.(this.canvas!);
        
        this.canvas!.toBlob(
          (blob) => {
            if (!blob) return;
            blob.arrayBuffer().then((buf) => {
              if (this.ws?.readyState !== WebSocket.OPEN) return;
              const payload: ClientToServerMessage = {
                type: "video",
                data: bufferToBase64(buf),
                mimeType: "image/jpeg",
              };
              this.ws.send(JSON.stringify(payload));
            });
          },
          "image/jpeg",
          0.85
        );
      }, VIDEO_FRAME_INTERVAL_MS);
    }).catch(() => {});
  }

  disconnect(): void {
    this.playbackQueue?.stop();

    if (this.videoInterval) {
      clearInterval(this.videoInterval);
      this.videoInterval = null;
    }

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
