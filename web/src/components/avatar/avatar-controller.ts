import type { AvatarState } from "@manglara/shared";
import { TalkingHead } from "@met4citizen/talkinghead";

/** Assistant audio from Gemini Live is 24 kHz, 16-bit LE PCM. */
const GEMINI_SAMPLE_RATE = 24000;

/**
 * Ready Player Me avatar (avatar1.glb): full Armature, 72 morph targets including
 * all Oculus visemes and ARKit blendshapes. Required for TalkingHead lip-sync.
 * Avaturn web exports don't include morph targets; RPM does via URL params.
 */
const AVATAR_URL = "/avatar1.glb";

/** Vendored HeadAudio (audio-driven viseme detection). Served from public/. */
const HEADAUDIO_BASE = "/headaudio";

export interface AvatarControllerCallbacks {
  /** Fires true when the avatar starts speaking audio, false when it stops. */
  onSpeakingChange?: (speaking: boolean) => void;
  onReady?: () => void;
  onError?: (error: unknown) => void;
}

/**
 * Bridges the app to the met4citizen avatar stack:
 *  - TalkingHead renders the RPM avatar, plays the streamed PCM and runs the
 *    built-in natural animations (blink, head move, eye contact, breathing).
 *  - HeadAudio taps the playback graph and produces Oculus visemes from the
 *    audio itself (language-agnostic), which drive the mouth morph targets.
 *
 * Lifecycle: construct once, `init()` on mount (loads avatar, idle), then
 * `startStream()`/`stopStream()` per call, feeding chunks with `feedAudio()`.
 */
export class AvatarController {
  private head: TalkingHead | null = null;
  // HeadAudio is an untyped, dynamically-imported AudioWorkletNode.
  private headAudio: {
    update(dt: number): void;
    onvalue: ((key: string, value: number) => void) | null;
    disconnect?: () => void;
  } | null = null;
  private headAudioReady = false;
  private streaming = false;
  private lastState: AvatarState | null = null;
  private _ready = false;
  private disposed = false;

  constructor(
    private node: HTMLElement,
    private callbacks: AvatarControllerCallbacks = {}
  ) {}

  get isReady(): boolean {
    return this._ready;
  }

  /** Create TalkingHead and load the avatar. Safe to call once. */
  async init(): Promise<void> {
    if (this.head || this.disposed) return;
    // Assign immediately so dispose() (e.g. StrictMode's double-mount) can tear
    // this instance down even while showAvatar is still loading.
    const head = new TalkingHead(this.node, {
      ttsEndpoint: "", // unused: TTS comes from Gemini Live
      lipsyncModules: ["en"], // visemes come from HeadAudio, not text
      lipsyncLang: "en",
      cameraView: "head",
      cameraRotateEnable: false,
      cameraPanEnable: false,
      cameraZoomEnable: false,
      avatarMood: "neutral",
      modelFPS: 30,
    });
    this.head = head;

    try {
      await head.showAvatar({
        url: AVATAR_URL,
        body: "F",
        lipsyncLang: "en",
        avatarMood: "neutral",
      });
      if (this.disposed) return; // disposed mid-load → dispose() handles teardown
      head.setView("head");
      head.start();
      this._ready = true;
      this.callbacks.onReady?.();
    } catch (error) {
      this.callbacks.onError?.(error);
      throw error;
    }
  }

  /** Enter streaming mode and wire HeadAudio. Idempotent across calls. */
  async startStream(): Promise<void> {
    const head = this.head;
    console.log("[headaudio] startStream called; head?", !!head, "streaming?", this.streaming);
    if (!head || this.streaming) return;

    await head.streamStart(
      { sampleRate: GEMINI_SAMPLE_RATE, lipsyncType: "visemes" },
      () => this.callbacks.onSpeakingChange?.(true),
      () => this.callbacks.onSpeakingChange?.(false)
    );
    this.streaming = true;

    await this.setupHeadAudio(head);
  }

  /** Feed one chunk of assistant PCM (24 kHz, 16-bit LE) for playback + lip-sync. */
  feedAudio(pcm: ArrayBuffer): void {
    if (!this.head || !this.streaming) return;
    this.head.streamAudio({ audio: pcm });
  }

  /** Signal the current utterance is complete (playback drains then idles). */
  notifyEnd(): void {
    if (this.streaming) this.head?.streamNotifyEnd();
  }

  /** Leave streaming mode (keeps the avatar mounted and idle). */
  stopStream(): void {
    if (!this.streaming) return;
    this.head?.streamStop();
    this.streaming = false;
  }

  /** Map the call state machine to gaze/mood behaviors. */
  setState(state: AvatarState): void {
    const head = this.head;
    if (!head || !this._ready || state === this.lastState) return;
    this.lastState = state;
    if (state === "thinking") {
      head.lookAhead(2000); // glance away while processing
    } else {
      head.lookAtCamera(500); // engage the user when idle/listening/speaking
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopStream();
    try {
      this.headAudio?.disconnect?.();
      if (this.head) {
        this.head.opt.update = undefined;
        this.head.stop();
        this.head.dispose();
      }
    } catch {
      // ignore teardown errors
    }
    // Remove any leftover canvas so a fresh controller starts clean.
    try {
      while (this.node.firstChild) this.node.removeChild(this.node.firstChild);
    } catch {
      // ignore
    }
    this.headAudio = null;
    this.headAudioReady = false;
    this.head = null;
    this._ready = false;
  }

  /** One-time HeadAudio setup: worklet + model + tap the streaming audio bus. */
  private async setupHeadAudio(head: TalkingHead): Promise<void> {
    if (this.headAudioReady) return;
    try {
      const log = (...a: unknown[]) => console.log("[headaudio]", ...a);
      log("setup start; ctx.sampleRate =", head.audioCtx.sampleRate);

      await head.audioCtx.audioWorklet.addModule(`${HEADAUDIO_BASE}/headworklet.min.mjs`);
      log("worklet added");

      const mod = await import(/* @vite-ignore */ `${HEADAUDIO_BASE}/headaudio.min.mjs`);
      const HeadAudio = mod.HeadAudio;
      log("module imported; HeadAudio =", typeof HeadAudio);

      // visemeEventsEnabled/vadEventsEnabled surface the onviseme/onvad
      // callbacks used below for diagnostics.
      const ha = new HeadAudio(head.audioCtx, {
        processorOptions: {
          sampleRate: head.audioCtx.sampleRate,
          visemeEventsEnabled: true,
          vadEventsEnabled: true,
        },
      });
      await ha.loadModel(`${HEADAUDIO_BASE}/model-en-mixed.bin`);
      log("model loaded");

      // Tap the streaming playback bus (streaming audio routes through
      // audioStreamGainNode, not audioSpeechGainNode).
      head.audioStreamGainNode.connect(ha);

      // Detected visemes drive the avatar mouth morph targets.
      let valueCount = 0;
      ha.onvalue = (key: string, value: number) => {
        const mt = head.mtAvatar[key];
        if (mt) {
          mt.newvalue = value;
          mt.needsUpdate = true;
        }
        if (valueCount < 12 && value > 0.01) {
          valueCount++;
          log("onvalue", key, value.toFixed(3), mt ? "(mapped)" : "(NO morph!)");
        }
      };
      // Diagnostics: does the worklet detect speech / visemes from the audio?
      let visemeCount = 0;
      ha.onviseme = (o: { viseme?: string }) => {
        if (visemeCount < 12) {
          visemeCount++;
          log("onviseme", o?.viseme);
        }
      };
      ha.onvad = (o: unknown) => log("onvad", o);

      // Animate viseme easing each render frame.
      head.opt.update = ha.update.bind(ha);

      // Expose for manual debugging in the console.
      (window as unknown as Record<string, unknown>).__head = head;
      (window as unknown as Record<string, unknown>).__headaudio = ha;

      this.headAudio = ha;
      this.headAudioReady = true;
      log("setup OK; opt.update wired");
    } catch (error) {
      // Non-fatal: audio still plays via TalkingHead, only lip-sync is lost.
      console.error("[headaudio] setup FAILED:", error);
      this.callbacks.onError?.(error);
    }
  }
}
