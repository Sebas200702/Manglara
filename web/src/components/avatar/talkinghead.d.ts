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
    /**
     * Highest-priority slot short of `fixed`, applied verbatim with no easing
     * and never written by the library itself: the hook for an external
     * real-time driver. Unlike `newvalue` it is NOT cleared after use - set it
     * back to null to release the morph (with `needsUpdate`, or the entry is
     * skipped and it sticks).
     */
    realtime?: number | null;
    /** Animation-priority slot. Consumed and cleared on the frame it applies. */
    newvalue: number | null;
    needsUpdate: boolean;
    /** Value currently applied to the meshes. */
    value?: number;
    /**
     * The `morphTargetInfluences` arrays this morph lives in, and the index it
     * occupies in each. One entry per mesh carrying the target, so a single
     * viseme can span the skin, teeth and tongue primitives.
     */
    ms?: Array<Float32Array | number[] | undefined>;
    is?: number[];
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
    /** Per-language lip-sync processors; we register one statically at load. */
    lipsync: Record<string, unknown>;

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
    /**
     * Turn her head and gaze to the screen position (x, y) in visual-viewport
     * coordinates for `t` milliseconds. Use this to follow the user's pointer
     * when she is idle or listening. Requires a mounted camera.
     */
    lookAt(x: number, y: number, t: number): void;
    /** Play a named pose from gestureTemplates; holds `dur` s, eases over `ms`. */
    playGesture(name: string, dur?: number, mirror?: boolean, ms?: number): void;
    /**
     * Relax the current gesture back to the idle pose over `ms`.
     *
     * Restores ONLY the props of the gesture it is holding, which is why every
     * beat we play has to name every joint it might have to give back - see
     * `avatar-controller.playGestureBeat`.
     */
    stopGesture(ms?: number): void;
    /**
     * Rest rotation/position of a joint in the current pose template, as
     * `"Bone.rotation"` or `"Bone.quaternion"`. Returns the value held by the
     * ACTIVE GESTURE for any joint that gesture covers, so it only reports the
     * true rest pose while nothing is playing. Undefined for an unknown joint.
     */
    getPoseTemplateProp(key: string): unknown;
    /**
     * IK-solve both arms to a random nearby target and ease them there and
     * back: conversational hand movement.
     *
     * Assignable on purpose: the library calls this itself on every
     * `playback-started`, and we replace it with a no-op so the arms have a
     * single director (see `avatar-controller.init`).
     */
    speakWithHands: (delay?: number, prob?: number) => void;
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

declare module "@met4citizen/talkinghead/modules/lipsync-en.mjs" {
  /** English text/word -> Oculus viseme processor (self-contained). */
  export class LipsyncEn {
    preProcessText(s: string): string;
    wordsToVisemes(w: string): unknown;
  }
}
