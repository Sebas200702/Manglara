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
    [key: string]: unknown;
  }

  export interface StreamAudioChunk {
    audio?: ArrayBuffer | Int16Array | Uint8Array | Float32Array;
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
    start(): void;
    stop(): void;

    streamStart(
      opt?: StreamStartOptions,
      onAudioStart?: (() => void) | null,
      onAudioEnd?: (() => void) | null,
      onSubtitles?: ((s: string) => void) | null,
      onMetrics?: ((m: unknown) => void) | null
    ): Promise<void>;
    streamAudio(r: StreamAudioChunk): void;
    streamNotifyEnd(): void;
    streamInterrupt(): void;
    streamStop(): void;
    dispose(): void;
  }
}
