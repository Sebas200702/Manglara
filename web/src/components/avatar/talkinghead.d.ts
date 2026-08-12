// Minimal type declarations for the (untyped) TalkingHead library.
// Only the surface we use is declared; the rest is permissive.
declare module "@met4citizen/talkinghead" {
  export interface TalkingHeadOptions {
    ttsEndpoint?: string;
    lipsyncModules?: string[];
    lipsyncLang?: string;
    cameraView?: "full" | "upper" | "mid" | "head";
    cameraRotateEnable?: boolean;
    cameraPanEnable?: boolean;
    cameraZoomEnable?: boolean;
    lightAmbientIntensity?: number;
    modelFPS?: number;
    avatarMood?: string;
    update?: (dt: number) => void;
    [key: string]: unknown;
  }

  type BoneCorrection = { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number };

  export interface ShowAvatarOptions {
    url: string;
    body?: "M" | "F";
    lipsyncLang?: string;
    avatarMood?: string;
    baseline?: Record<string, number>;
    retarget?: Record<string, BoneCorrection | number>;
    [key: string]: unknown;
  }

  export interface StreamStartOptions {
    sampleRate?: number;
    gain?: number;
    lipsyncType?: "visemes" | "blendshapes" | "words";
    lipsyncLang?: string;
    waitForAudioChunks?: boolean;
    mood?: string;
    /** Playback-worklet queue reporting. Off by default in the library. */
    metrics?: { enabled: boolean; intervalHz?: number };
    [key: string]: unknown;
  }

  /**
   * Report from the playback worklet (see modules/playback-worklet.js).
   * `queuedSamples` counts PCM samples handed over but NOT yet rendered, which
   * makes it the only exact measure of the true playback position.
   */
  export interface PlaybackMetrics {
    /** 0 = idle, 1 = playing. */
    state: number;
    queuedSamples: number;
    /** Same figure in ms, computed against the AudioContext's sample rate. */
    queuedMs: number;
    maxQueuedMs: number;
    underrunBlocks: number;
    framesProcessed: number;
  }

  export interface PlaybackMetricsMessage {
    type: string;
    data: PlaybackMetrics;
  }

  export interface StreamAudioChunk {
    audio?: ArrayBuffer | Int16Array | Uint8Array | Float32Array;
    /** Oculus viseme IDs (no `viseme_` prefix) to schedule against the audio. */
    visemes?: string[];
    /** Start of each viseme, ms from the start of the streamed utterance. */
    vtimes?: number[];
    vdurations?: number[];
    [key: string]: unknown;
  }

  /** Internal morph-target entry (subset used to drive lip-sync externally). */
  export interface MorphTargetEntry {
    newvalue: number | null;
    needsUpdate: boolean;
    [key: string]: unknown;
  }

  export class TalkingHead {
    constructor(node: HTMLElement, opt?: TalkingHeadOptions);
    audioCtx: AudioContext;
    audioStreamGainNode: GainNode;
    audioSpeechGainNode: GainNode;
    mtAvatar: Record<string, MorphTargetEntry | undefined>;
    opt: TalkingHeadOptions;
    /** True while the stream worklet is actually playing audio out. */
    isSpeaking: boolean;
    /** Named pose templates; we register rig-safe body-language ones at load. */
    gestureTemplates: Record<string, Record<string, unknown>>;

    showAvatar(
      avatar: ShowAvatarOptions,
      onprogress?: ((e: ProgressEvent) => void) | null
    ): Promise<void>;
    setView(
      view: "full" | "upper" | "mid" | "head",
      opt?: Record<string, number> | null
    ): void;
    setMood(mood: string): void;
    lookAtCamera(t: number): void;
    lookAhead(t: number): void;
    makeEyeContact(t: number): void;
    /** Play a named pose from gestureTemplates; holds `dur` s, eases over `ms`. */
    playGesture(name: string, dur?: number, mirror?: boolean, ms?: number): void;
    /** Relax the current gesture back to the idle pose over `ms`. */
    stopGesture(ms?: number): void;
    start(): void;
    stop(): void;

    streamStart(
      opt?: StreamStartOptions,
      onAudioStart?: (() => void) | null,
      onAudioEnd?: (() => void) | null,
      onSubtitles?: ((s: string) => void) | null,
      onMetrics?: ((m: PlaybackMetricsMessage) => void) | null
    ): Promise<void>;
    streamAudio(r: StreamAudioChunk): void;
    streamNotifyEnd(): void;
    streamInterrupt(): void;
    streamStop(): void;
    dispose(): void;
  }
}
