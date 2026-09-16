import type { AvatarState } from "@manglara/shared";
import { TalkingHead } from "@met4citizen/talkinghead";
import type { PlaybackMetricsMessage } from "@met4citizen/talkinghead";
import { CanvasTexture, Euler, MeshBasicMaterial, Quaternion, SRGBColorSpace } from "three";
import type { Bone, Material, Mesh, MeshStandardMaterial, Object3D } from "three";
// Statically bundle the English lip-sync processor. TalkingHead otherwise loads
// it via `import('./lipsync-en.mjs')` - an un-analyzable dynamic import that
// Rollup can't bundle, so in production it 404s at /assets/lipsync-en.mjs. We
// import it here (Vite bundles it) and register it on the instance below.
import { LipsyncEn } from "@met4citizen/talkinghead/modules/lipsync-en.mjs";
import { spanishTextToUnits, unitsDuration } from "./lipsync-es";
import { VisemeDriver } from "./viseme-driver";
import { ARM_GESTURES, BODY_GESTURES, MotionDirector } from "./motion-director";
import type { MotionAction } from "./motion-director";
import { blendLipShapes } from "./lip-shapes";
import type { LipShape } from "./lip-shapes";

/** Assistant audio from Gemini Live is 24 kHz, 16-bit LE PCM. */
const GEMINI_SAMPLE_RATE = 24000;

/**
 * Mouth-shape strength. Higher than TalkingHead's own 0.6 for visemes because
 * the whole point here is that the shapes be readable.
 */
const VISEME_LEVEL = 0.78;
/** Lip closure (P/B/M, F/V) has to look definite to read as a closure. */
const VISEME_LEVEL_CLOSED = 0.95;

/**
 * How long the shape queue must stay dry, with audio still playing, before the
 * audio-driven fallback takes the mouth back. Long enough that the ordinary gaps
 * between transcript fragments never trigger a swap.
 */
const HANDOVER_AFTER_DRY_MS = 900;

/**
 * How often the playback worklet reports its queue depth. Its queue is the only
 * exact measure of the true playback position (see `onPlaybackMetrics`), so this
 * is the lip-sync clock's sample rate. 25 Hz costs one small postMessage per
 * 40 ms and keeps the extrapolation window between reports below one frame.
 */
const PLAYBACK_METRICS_HZ = 25;
/**
 * Ceiling on how far the clock may be extrapolated past the last report. Reports
 * land every ~41 ms in practice, so three intervals is ample slack for jitter while
 * bounding how wrong the clock can be between two of them.
 */
const METRICS_EXTRAPOLATE_MAX_MS = 120;
/**
 * Ceiling on the speaker-latency compensation. Over-compensating would push the
 * mouth BEHIND the voice, which is worse than not compensating at all.
 */
const MAX_OUTPUT_LATENCY_MS = 300;
/** Where the learned speaking tempo is kept between sessions. */
const PACE_RATE_KEY = "manglara.lipsync.paceRate";

/**
 * Manglara "shapes key" model, normalised for TalkingHead by
 * scripts/avatar-rig-transfer/fix_shapeskey_glb.py: the raw export ships a full
 * Mixamo skeleton (bones prefixed `mixamorig:`) plus the full ARKit + Oculus
 * viseme morph set on a single `body.001` mesh, but TalkingHead needs the
 * prefix stripped (else `Hips not found`) and `LeftEye`/`RightEye` bones (it
 * reads their world position with no null guard). The script fixes both.
 *
 * `manglaria.glb` (the newer `manglaria.fbx` conversion, root transform fixed by
 * fix_manglaria_root.py) also loads, but it bakes every surface into one atlas
 * whose skin islands are the same orange as the dress - so the per-material
 * grading below has nothing to grip. Reachable via `VITE_AVATAR_URL`.
 */
const AVATAR_URL = import.meta.env.VITE_AVATAR_URL ?? "/Test_Manglara_V4.glb";

/**
 * Facial mood expressiveness (rig-safe: moods drive only face + head-sway, never
 * the smeared body/arm skin weights, so they never balloon the dress). Manglara's
 * resting and speaking face is warm and smiling with animated brows and head-sway
 * ("happy" carries a dedicated speaking animation), dropping to a calmer "neutral"
 * face while she glances away thinking. "love" is deliberately NOT used: its
 * baseline half-lids the eyes (eyeBlink 0.6), which reads as dreamy, not
 * professional. See animMoods in @met4citizen/talkinghead.
 */
const DEFAULT_MOOD = "happy";
const THINKING_MOOD = "neutral";

/**
 * Slot in `gestureTemplates` the composed beat is written to. One name,
 * rewritten per beat: `playGesture` reads the template synchronously, so nothing
 * is ever looking at the previous contents.
 */
const GESTURE_BEAT_NAME = "__manglaraBeat";
/**
 * How long a gesture takes to release at the end of a turn. TalkingHead spends
 * most of a pose transition in the first 40% of the window, so a short release
 * reads as the arms being dropped rather than lowered.
 */
const GESTURE_RELAX_MS = 700;

/** How fast the conversational face (brows, eyes, cheeks) chases its target. */
const FACIAL_RESPONSE_MS = 55;
/**
 * How a speech accent rises and falls on the brows. The target decays and the
 * value chases it: an accent that is only a decay has no rise, so the brow
 * appears at its new height in one frame and reads as a flicker.
 */
const EMPHASIS_DECAY_MS = 380;
const EMPHASIS_ATTACK_MS = 90;
/**
 * The head half of a speech accent, added onto the Head BONE rather than
 * written to TalkingHead's `headRotateX/Y/Z`.
 *
 * Those are realtime morphs, applied verbatim with no easing, so assigning one
 * is a single-frame step of several degrees - up to twice a second, and the most
 * visible jump of the lot. As a delta on the bone the library's idle head
 * movement keeps running underneath, and the stroke gets an explicit rise: it
 * ramps over ATTACK from wherever the head already is (so an accent landing
 * mid-flight is still continuous), then decays with TAU.
 */
const HEAD_ACCENT_ATTACK_MS = 110;
const HEAD_ACCENT_TAU_MS = 200;
/**
 * Lids down, then lids up.
 *
 * Driven straight onto the rig at realtime priority rather than through the
 * expression lerp: a blink is over in under 200 ms, and a smoothing stage on top
 * of a per-frame decay only ever gets the lids about a quarter closed - a
 * heavy-lidded look instead of a blink. Closing faster than opening is what a
 * real blink does.
 */
const BLINK_CLOSE_MS = 70;
const BLINK_OPEN_MS = 120;

/**
 * Idle gaze wander, layered on top of whatever TalkingHead decides.
 *
 * Measured over 25-second windows, the library moves the eyes horizontally on
 * roughly 7% of frames - its saccades fire on a 2-10 second timer, so between
 * them the gaze is perfectly still, which reads as a doll. Its vertical range is
 * also deliberately asymmetric (`eyesRotateX: [[-0.2, 0.6]]`, three times
 * further down than up), so she almost never looks up.
 *
 * Units are TalkingHead's own gaze units (the eyeLook* morph weights), not
 * radians: on this rig the eyeballs are moved by the ARKit gaze morphs, and the
 * `LeftEye`/`RightEye` bones added by fix_shapeskey_glb.py are unskinned - they
 * exist only so the library can read a world position. Rotating them would move
 * nothing at all, so the wander is added to the morphs instead.
 *
 * The two frequencies per axis are incommensurate, so the pattern does not
 * visibly repeat and it needs no random source in the render loop.
 */
const EYE_WANDER_YAW = 0.1;
const EYE_WANDER_PITCH = 0.07;
/** Ceiling on the combined gaze, so the wander can never push the iris into the corner. */
const EYE_MAX_YAW = 0.65;
const EYE_MAX_PITCH = 0.45;
/**
 * Cancels TalkingHead's constant downward gaze bias. Its look-at computes
 * `eyesRotateX: [-3 * drotx + 0.1]` - the `0.1` is a hardcoded stylistic offset
 * for its reference avatar, not part of the look-at maths, and combined with the
 * asymmetric saccade range it puts a hard floor under the vertical gaze.
 */
const EYE_PITCH_TRIM = 0.1;
/** The morphs the gaze is written across, so they can be released together. */
const GAZE_MORPHS = [
  "eyeLookOutLeft", "eyeLookInLeft", "eyeLookOutRight", "eyeLookInRight",
  "eyesLookUp", "eyesLookDown",
];

/**
 * Pointer-following gaze (trackPointer / lookAt).
 *
 * LOOK_DUR_MS: how long TalkingHead holds the pose before it fades back to its
 * own saccade logic. Long enough that a normal cursor path doesn't visually
 * stutter, short enough that she returns to eye-contact quickly when the pointer
 * sits still.
 *
 * THROTTLE_MS: minimum gap between two lookAt calls. The browser fires
 * pointermove at up to 120+ Hz; calling lookAt on every event restarts the
 * transition every frame and cancels the animation before it completes, so the
 * head oscillates rather than following smoothly. 80 ms ≈ one frame at 12 fps,
 * which is slow enough that each pose travels a visible arc.
 *
 * Only 'idle' and 'listening' follow the pointer: while speaking, makeEyeContact
 * already directs gaze and must not be interrupted; while thinking, lookAhead is
 * a deliberate "I'm pondering" look that should hold.
 */
const POINTER_LOOK_DUR_MS = 350;
const POINTER_THROTTLE_MS = 80;
const POINTER_TRACK_STATES = new Set<AvatarState>(["idle", "listening"]);

/** Vendored HeadAudio (audio-driven viseme detection). Served from public/. */
const HEADAUDIO_BASE = "/headaudio";


/**
 * Reflection strength from the scene's HDR environment. TalkingHead sets it to
 * 1; halving it takes the last of the plasticky sheen off without dulling the
 * eyes (which stay glossy via their low roughness).
 */
const ENV_MAP_INTENSITY = 0.5;

/**
 * Scene exposure.
 *
 * TalkingHead lights its stage for a Ready Player Me avatar with a photographic
 * skin texture: ambient 2, a directional at 30, a full RoomEnvironment IBL on
 * top, and ACES filmic tone mapping at exposure 1. That is several stops more
 * light than this character's flat, hand-painted textures can take - ACES rolls
 * the highlights off toward white and desaturates as it does, so every surface
 * came out a stop or two too pale: the sash, which is a deep olive in the GLB
 * (baseColorFactor 0.06/0.11/0.02, about #455C28), was rendering as a grey-green.
 *
 * Measured off the GLB rather than guessed: the point of these numbers is that
 * the albedo the modeller painted is what reaches the screen. The directional is
 * the big lever - it is what was blowing out the forehead, nose and cheeks.
 */
const LIGHT_AMBIENT_INTENSITY = 1.1;
const LIGHT_DIRECT_INTENSITY = 9;
const TONE_MAPPING_EXPOSURE = 0.85;

/**
 * The learned speaking tempo, kept between sessions. It is only exactly measurable
 * at the end of a turn, so without this the first turn of every call runs on the
 * duration table's guess and visibly drifts before the first correction lands.
 */
function loadPaceRate(): number | null {
  try {
    const raw = window.localStorage.getItem(PACE_RATE_KEY);
    if (!raw) return null;
    const rate = Number.parseFloat(raw);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null; // private mode / storage disabled
  }
}

function savePaceRate(rate: number): void {
  try {
    window.localStorage.setItem(PACE_RATE_KEY, String(rate));
  } catch {
    // ignore: losing the calibration only costs one turn next time
  }
}

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

  // --- body language, expression and gaze -----------------------------------
  /** Decides WHAT the body does; this class only executes it. */
  private motion = new MotionDirector();
  /** Conversational state the face and the body are dressed for. */
  private currentState: AvatarState = "idle";
  /**
   * Rest rotation of every joint a beat can move, read once at load. A beat has
   * to be able to send home the joints the previous beat posed - see
   * playGestureBeat.
   */
  private restProps: Record<string, { x: number; y: number; z: number; w: number }> = {};
  /** The Head bone, for the accent delta. Null on a rig without one. */
  private headBone: Bone | null = null;
  /** Brow/eye/cheek values currently applied, so they can be eased. */
  private facialMorphs: Record<string, number> = {};
  /** Speech emphasis: the target decays, the value chases it. */
  private emphasisTarget = 0;
  private emphasisValue = 0;
  /** The live head accent, and the stroke it is travelling along. */
  private headAccent = { x: 0, y: 0, z: 0 };
  private accentFrom = { x: 0, y: 0, z: 0 };
  private accentTo = { x: 0, y: 0, z: 0 };
  private accentAttack = 1;
  private readonly accentEuler = new Euler();
  private readonly accentDelta = new Quaternion();
  /** The pose the accent was layered on, and what we left on the bone. */
  private readonly accentPose = new Quaternion();
  private readonly accentWritten = new Quaternion();
  private accentHolds = false;
  /** Time left in a directed blink, ms. Zero means the library owns the lids. */
  private blinkMs = 0;
  /** Seconds since load, driving the idle gaze wander. */
  private eyeClock = 0;
  /** Whether the gaze morphs are currently held, so they can be released once. */
  private gazeHeld = false;
  /** `performance.now()` of the last `lookAt` call (pointer throttle). */
  private lastPointerLookAt = 0;

  // Sprite mouth: the avatar GLB ships a "MouthOverlay" patch hugging the
  // mouth region (transparent at rest). Each frame we paint a viseme-driven
  // mouth (dark cavity + teeth) onto it, so the character visibly opens her
  // mouth while talking - morphs alone can't show a cavity on a sealed mesh.
  private mouthMesh: Mesh | null = null;
  private mouthCtx: CanvasRenderingContext2D | null = null;
  private mouthTex: CanvasTexture | null = null;
  private lastShape: LipShape | null = null;

  // Text-driven lip-sync. Mouth shapes come from the transcript and are consumed
  // against the audio playback clock rather than scheduled at absolute times:
  // Gemini streams audio far faster than real time, so "how much audio we were
  // handed" says nothing about what is being heard right now. See viseme-driver.
  private driver = new VisemeDriver();
  /** Duration of PCM handed to playback, ms. Exact - it's a byte count. */
  private audioFedMs = 0;

  // --- the playback clock ---------------------------------------------------
  // Measured, never integrated. TalkingHead clamps the frame delta it hands to
  // `opt.update` at two frame durations (talkinghead.mjs: `if (dt > 2 *
  // animFrameDur) dt = 2 * animFrameDur`, 66 ms at modelFPS 30), so a clock built
  // by adding up those deltas permanently loses every dropped frame. This app drops
  // frames on a schedule - the webcam capture JPEG-encodes and base64s a 640x480
  // frame on the main thread every 1.5 s for the whole call - so that clock ran
  // slower than the voice and the mouth fell further behind the longer she spoke.
  /** Audio actually heard as of the last worklet report, ms. */
  private syncPlayedMs = 0;
  /** `performance.now()` when that report landed. */
  private syncAt = 0;
  /** Monotonic measured playback position handed to the driver, ms. */
  private playedMs = 0;
  /** Whether the worklet has reported at all since the last reset. */
  private haveMetrics = false;
  /**
   * Speaker latency: audio already handed to the sound card but not yet audible.
   * The mouth must show what the EAR hears, so this is subtracted from the
   * worklet's position. On Windows/WASAPI it is routinely 100-200 ms, which on its
   * own is a plainly visible lead of the mouth over the voice.
   */
  private outputLatencyMs = 0;
  /** Viseme morphs written last frame, so they can be released. */
  private writtenVisemes = new Set<string>();
  /** True once a transcript arrived at all. */
  private textVisemesActive = false;
  /**
   * Whether text is driving the mouth *this frame*. Goes false when the queue
   * runs dry while audio is still playing, handing over to HeadAudio - without
   * that, a transcript that lags or drops leaves the mouth frozen.
   */
  private textInCharge = false;
  /** Set by notifyEnd(): the next `onAudioEnd` really is the end of the turn. */
  private turnEnded = false;
  /** Debug: pin one viseme so its shape can be inspected. `window.__hold`. */
  private heldViseme: string | null = null;
  /**
   * Debug: mouth text with NO audio at all. Runs the driver off a synthetic
   * clock, so it needs no AudioContext (hence no user gesture), no mic and no
   * Gemini session - just the loaded avatar. `window.__say`.
   */
  private dryRun = false;
  /** Debug: log the driving source and timing. `window.__lipsyncLog`. */
  private diagnose = false;
  private diagLastLog = 0;
  /** How long the shape queue has been dry while audio kept playing, ms. */
  private dryMs = 0;
  /**
   * Jitter pre-buffer for streaming audio. Absorbs WebSocket and event-loop timing
   * variations before handing samples over to the playback worklet, preventing
   * buffer underrun clicks, stuttering, and micro-freezes.
   */
  private static readonly PREBUFFER_MS = 160;
  private audioBufferQueue: ArrayBuffer[] = [];
  private audioBufferedMs = 0;
  /**
   * Debug capture of the live timeline (`window.__lipsyncRecord`). Answers the
   * one question tuning cannot: does a transcript fragment arrive aligned in
   * CONTENT with the audio it describes, or does it trail it? If it trails, no
   * pacing scheme can be in sync and the audio has to be delayed instead.
   */
  private rec:
    | { at: number; kind: "tx" | "au"; fed: number; textMs: number; heard: number }[]
    | null = null;
  private recStart = 0;
  private recTextMs = 0;
  /** Where the lip-sync clock got reset, and how often. A clock that keeps
   *  returning to zero is why the capture showed audio_entregado=0 throughout. */
  private resetCounts: Record<string, number> = {};

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
      // Empty so TalkingHead does NOT fire its dynamic import('./lipsync-en.mjs')
      // (404 in prod). We register the statically-imported processor right after
      // construction instead. Visemes come from HeadAudio/VisemeDriver anyway.
      lipsyncModules: [],
      lipsyncLang: "en",
      cameraView: "head",
      cameraRotateEnable: false,
      cameraPanEnable: false,
      cameraZoomEnable: false,
      // Warm, lively resting face from the first frame. "happy" carries a smile
      // baseline plus animated brows/head-sway/micro-mouth (see animMoods in
      // talkinghead.mjs) - all facial, so it costs nothing on the body rig and is
      // the expressiveness the arm gestures can't safely provide on this mesh.
      avatarMood: DEFAULT_MOOD,
      modelFPS: 30,
      // See LIGHT_AMBIENT_INTENSITY: the library's stage is lit for a
      // photographic RPM avatar and burns out this character's flat textures.
      lightAmbientIntensity: LIGHT_AMBIENT_INTENSITY,
      lightDirectIntensity: LIGHT_DIRECT_INTENSITY,
    });
    this.head = head;
    // Register the statically-bundled lip-sync processor (see import note). This
    // replaces TalkingHead's dynamic-import path so it works in the prod bundle.
    head.lipsync = { en: new LipsyncEn() };

    try {
      await head.showAvatar({
        url: AVATAR_URL,
        body: "F",
        lipsyncLang: "en",
        avatarMood: DEFAULT_MOOD,
      });
      if (this.disposed) return; // disposed mid-load → dispose() handles teardown
      // Framing tuned for the Manglara character (big afro): "head" view crops
      // her. This was 1.5 / 0.5, which cut just below the collarbone - fine when
      // the body language was torso-only, but the arm beats put the forearms
      // around chest height and played entirely off-screen. Keep a little more
      // breathing room so the afro, shoulders and hand gestures stay in frame.
      head.setView("upper", { cameraDistance: 2, cameraY: 0.6 });
      this.gradeScene(head);
      this.dampenMaterials(head);
      this.registerBodyLanguage(head);
      this.captureRestPose(head);
      this.captureBones(head);
      // TalkingHead fires `speakWithHands()` itself on every `playback-started`,
      // which in a streamed turn is every recovery from a buffer underrun, not
      // once per answer. That pushes a ~3.5 s IK animation onto the arms
      // underneath our own beats, and the next `playGesture` truncates it by
      // zeroing its keyframe times - which runs its whole timeline, including
      // the return-to-rest move, inside a single frame. Both halves of that are
      // visible as a jump. The body is directed from `motion-director` instead,
      // so the library's version is disabled outright.
      head.speakWithHands = () => {};
      this.setupMouthSprite(head);
      // Single per-frame hook, wired before any streaming starts so the mouth
      // works regardless of whether HeadAudio (the fallback) ever loads.
      // TalkingHead calls this right before it applies morph targets, and after
      // it has resolved this frame's pose onto the bones - which is what makes
      // the head accent below legal.
      head.opt.update = (dt: number) => {
        this.updateVisemes(dt);
        // HeadAudio always ticks (it tracks the audio continuously), but its
        // morph writes are gated on `textInCharge` inside its onvalue hook -
        // both write the same `newvalue` slot, so only one may win per frame.
        // Running after us means it takes over cleanly when text runs dry.
        this.headAudio?.update(dt);
        this.drawMouth();
        this.updateFacialExpressions(dt);
        this.updateHeadAccent(dt);
        // Last: it reads the gaze morphs the animation pass just wrote.
        this.updateGaze(dt);
      };
      head.start();
      this._ready = true;
      // Expose for manual debugging in the console.
      const dbg = window as unknown as Record<string, unknown>;
      dbg.__head = head;
      dbg.__avatar = this; // the controller itself, for poking at state
      dbg.__sayTest = (text: string) => this.testLipsync(text);
      // Audio-free lip-sync testing surface. See scripts/lipsync-console-test.js.
      dbg.__say = (text: string) => this.say(text);
      dbg.__phonemes = (text: string) => this.phonemesOf(text);
      dbg.__visemes = AvatarController.VISEMES;
      dbg.__mood = (mood: string) => {
        this.setMood(mood);
        console.log("[mood]", mood);
      };
      // Try one whole-body beat by hand: `__body('side')`, `__body(null,'nod')`.
      dbg.__body = (arm: string | null, torso = "leanIn", mirror = false) => {
        this.playGestureBeat(arm, torso, mirror);
        console.log("[body]", arm ?? "(sin brazo)", torso, mirror ? "espejo" : "");
      };
      dbg.__armGestures = ARM_GESTURES;
      dbg.__torsoGestures = Object.keys(BODY_GESTURES);
      dbg.__hold = (viseme: string | null) => {
        this.hold(viseme);
        console.log("[lipsync] holding", viseme ?? "(released)");
      };
      // Log what is actually driving the mouth, to settle sync questions with
      // data instead of guesswork.
      dbg.__lipsyncRecord = (on = true) => this.recordTimeline(on);
      dbg.__lipsyncReport = () => console.log(this.reportTimeline());
      dbg.__lipsyncLog = (on = true) => {
        this.diagnose = on;
        console.log("[lipsync] diagnostics", on ? "on" : "off");
      };
      this.callbacks.onReady?.();
    } catch (error) {
      this.callbacks.onError?.(error);
      throw error;
    }
  }

  // WebAudio Analyser for 100% real-time audio-driven lip-sync
  private analyserNode: AnalyserNode | null = null;
  // Explicitly over `ArrayBuffer`: the bare `Uint8Array` alias is
  // `Uint8Array<ArrayBufferLike>`, which the AnalyserNode read methods reject
  // because they cannot write into a SharedArrayBuffer.
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private timeData: Uint8Array<ArrayBuffer> | null = null;

  /** Enter streaming mode and wire HeadAudio. Idempotent across calls. */
  async startStream(): Promise<void> {
    const head = this.head;
    console.log("[headaudio] startStream called; head?", !!head, "streaming?", this.streaming);
    if (!head || this.streaming) return;

    // Carry the tempo measured in earlier sessions in, so the very first turn of a
    // call is already calibrated instead of running on the duration table's guess.
    const seeded = loadPaceRate();
    if (seeded !== null) {
      this.driver.seedRate(seeded);
      console.log("[lipsync] tempo inicial aprendido:", seeded.toFixed(3));
    }

    await head.streamStart(
      {
        sampleRate: GEMINI_SAMPLE_RATE,
        lipsyncType: "visemes",
        // Switches on the playback worklet's queue reporting. The library defaults
        // it OFF, which is why the mouth had no real clock to run on.
        metrics: { enabled: true, intervalHz: PLAYBACK_METRICS_HZ },
      },
      () => this.callbacks.onSpeakingChange?.(true),
      () => {
        // Only clears on a real end of turn. `playback-ended` also fires on a
        // mid-sentence buffer underrun, and dropping pending shapes there is
        // exactly what makes the mouth stop partway through a phrase.
        if (this.turnEnded) {
          this.turnEnded = false;
          // End of turn is the ONLY moment the speaking tempo can be measured:
          // the transcript is complete, so audio/estimate is ground truth. The
          // driver keeps it across turns and uses it to lay out the next one.
          this.driver.endTurn(this.audioFedMs);
          savePaceRate(this.driver.rate);
          this.resetVisemeState("turn_complete");
        }
        this.callbacks.onSpeakingChange?.(false);
      },
      null, // onSubtitles: Gemini's transcript goes to feedTranscript instead
      (m) => this.onPlaybackMetrics(m)
    );
    this.streaming = true;
    this.resetVisemeState("startStream");

    if (head.audioCtx && head.audioCtx.state === "suspended") {
      try {
        await head.audioCtx.resume();
        console.log("[lipsync] audioCtx reanudado correctamente");
      } catch (err) {
        console.warn("[lipsync] error al reanudar audioCtx:", err);
      }
    }

    // AFTER streamStart: it recreates the AudioContext when the requested sample
    // rate differs from the current one, so reading latency earlier would measure a
    // context that no longer exists.
    this.measureOutputLatency(head);

    // Wire WebAudio AnalyserNode directly to the playback audio bus for zero-latency lip sync
    if (head.audioStreamGainNode) {
      try {
        const analyser = head.audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.2;
        head.audioStreamGainNode.connect(analyser);
        this.analyserNode = analyser;
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
        this.timeData = new Uint8Array(analyser.fftSize);
        console.log("[lipsync] AnalyserNode conectado a audioStreamGainNode");
      } catch (err) {
        console.warn("[lipsync] AnalyserNode setup error:", err);
      }
    }

    await this.setupHeadAudio(head);
  }

  /**
   * Read the speaker latency once per stream.
   *
   * `outputLatency` is the gap between audio leaving the graph and reaching the
   * ear. Where the browser doesn't report it, `baseLatency` (the graph's own
   * buffering) is the only signal available and is doubled as a rough stand-in for
   * the device buffer behind it.
   */
  private measureOutputLatency(head: TalkingHead): void {
    const ctx = head.audioCtx;
    const finite = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    const out = finite(ctx.outputLatency);
    const base = finite(ctx.baseLatency);
    const ms = (out > 0 ? out : base * 2) * 1000;
    this.outputLatencyMs = Math.min(Math.max(ms, 0), MAX_OUTPUT_LATENCY_MS);
    console.log(
      `[lipsync] latencia de salida ${Math.round(this.outputLatencyMs)}ms ` +
        `(outputLatency=${(out * 1000).toFixed(0)}ms baseLatency=${(base * 1000).toFixed(0)}ms) ` +
        `ctx.sampleRate=${ctx.sampleRate}`
    );
    if (ctx.sampleRate !== GEMINI_SAMPLE_RATE) {
      // The playback worklet copies PCM samples 1:1 into its output - it does NOT
      // resample. A mismatch here means the voice itself plays at the wrong speed
      // and pitch, which no lip-sync scheme can follow.
      console.error(
        `[lipsync] AudioContext corre a ${ctx.sampleRate}Hz pero el PCM es de ` +
          `${GEMINI_SAMPLE_RATE}Hz y el worklet no remuestrea: la voz sonará ` +
          `a ${(ctx.sampleRate / GEMINI_SAMPLE_RATE).toFixed(2)}x su velocidad.`
      );
    }
  }

  /**
   * The real playback position, from the worklet's queue depth.
   *
   * `queuedSamples` counts PCM handed over but not yet rendered, so
   * `audioFedMs - queued` is exactly how much audio has left the graph - a
   * measurement, not an estimate, and self-correcting on every report. Subtracting
   * the speaker latency turns it into what the ear is hearing right now.
   */
  private onPlaybackMetrics(msg: PlaybackMetricsMessage): void {
    const data = msg?.data;
    if (!data || typeof data.queuedSamples !== "number") return;
    if (data.state === 0) {
      if (this.audioFedMs > 0) {
        const heard = Math.max(0, this.audioFedMs - this.outputLatencyMs);
        this.syncPlayedMs = Math.min(heard, this.audioFedMs);
        this.syncAt = performance.now();
        this.haveMetrics = true;
      } else {
        this.haveMetrics = false;
      }
      return;
    }
    // Convert with OUR sample rate, not the worklet's `queuedMs`: the queue holds
    // the very samples `audioFedMs` counted, so this keeps both clocks on one
    // scale even if the AudioContext ended up at a different rate.
    const queuedMs = data.queuedSamples / (GEMINI_SAMPLE_RATE / 1000);
    const heard = this.audioFedMs - queuedMs - this.outputLatencyMs;
    this.syncPlayedMs = Math.min(Math.max(heard, 0), this.audioFedMs);
    this.syncAt = performance.now();
    this.haveMetrics = true;
  }

  /** Push a shape into the morph targets, releasing whatever was held before. */
  private writeVisemeMorphs(shape: string | null): void {
    const head = this.head;
    if (!head) return;
    const key = shape ? `viseme_${shape}` : null;

    const applyMorph = (k: string, val: number) => {
      const mt = head.mtAvatar[k];
      if (mt) {
        mt.newvalue = val;
        mt.needsUpdate = true;
        // Synchronously copy to Three.js morphTargetInfluences so drawMouth() reads current values immediately
        const arrays = mt.ms;
        const indices = mt.is;
        if (arrays && indices) {
          for (let i = 0; i < arrays.length; i++) {
            const arr = arrays[i];
            const idx = indices[i];
            if (arr && idx !== undefined) arr[idx] = val;
          }
        }
      }
    };

    if (key) {
      const targetVal =
        shape === "PP" || shape === "FF" ? VISEME_LEVEL_CLOSED : VISEME_LEVEL;
      applyMorph(key, targetVal);
    }
    // Release anything held last frame.
    for (const prev of this.writtenVisemes) {
      if (prev === key) continue;
      applyMorph(prev, 0);
    }
    this.writtenVisemes.clear();
    if (key) this.writtenVisemes.add(key);
  }

  /**
   * The playback position for this frame, or undefined before the first report.
   *
   * Between reports the position is advanced by WALL time, never by the frame delta
   * - that delta is the clamped one described above. Each report re-anchors it, so
   * error cannot accumulate: the worst case is one report interval of extrapolation.
   */
  private measurePlayback(): number | undefined {
    if (!this.haveMetrics) return undefined;
    const ahead = Math.min(
      Math.max(performance.now() - this.syncAt, 0),
      METRICS_EXTRAPOLATE_MAX_MS
    );
    const next = Math.min(this.syncPlayedMs + ahead, this.audioFedMs);
    // Monotonic: a report crossing the thread boundary can describe a moment
    // already passed, and letting it pull the mouth backwards reads as a stutter.
    this.playedMs = Math.max(this.playedMs, next);
    return this.playedMs;
  }

  /** Feed one chunk of assistant PCM (24 kHz, 16-bit LE) for playback + lip-sync. */
  feedAudio(pcm: ArrayBuffer): void {
    if (!this.head || !this.streaming) return;
    this.turnEnded = false; // fresh audio: this turn is still going

    if (this.head.audioCtx && this.head.audioCtx.state === "suspended") {
      void this.head.audioCtx.resume();
    }

    // MEASURE FIRST. `streamAudio` posts the ArrayBuffer to the worklet with a
    // transfer list (talkinghead.mjs: `postMessage(message, [message.data])`),
    // which DETACHES it - `pcm.byteLength` is 0 afterwards. Reading it after the
    // call meant `audioFedMs` never left 0, so `buffered` was always 0 and the
    // driver ran permanently at MAX_RATE (1.9x).
    // 16-bit mono at 24 kHz → 48 bytes per ms.
    const chunkMs = pcm.byteLength / 2 / (GEMINI_SAMPLE_RATE / 1000);

    // If the worklet is already actively playing and there is no held pre-buffer,
    // feed directly to keep latency minimal.
    if (this.head.isSpeaking && this.audioBufferQueue.length === 0) {
      this.head.streamAudio({ audio: pcm });
      this.audioFedMs += chunkMs;
      this.record("au");
      return;
    }

    // Otherwise, accumulate in the initial jitter buffer to absorb network latency
    // spikes before kicking off playback.
    this.audioBufferQueue.push(pcm);
    this.audioBufferedMs += chunkMs;

    if (this.audioBufferedMs >= AvatarController.PREBUFFER_MS) {
      this.flushAudioBuffer();
    }
  }

  private flushAudioBuffer(): void {
    if (!this.head || !this.streaming || this.audioBufferQueue.length === 0) return;
    const queue = this.audioBufferQueue;
    this.audioBufferQueue = [];
    this.audioBufferedMs = 0;

    for (const chunk of queue) {
      const chunkMs = chunk.byteLength / 2 / (GEMINI_SAMPLE_RATE / 1000);
      this.head.streamAudio({ audio: chunk });
      this.audioFedMs += chunkMs;
      this.record("au");
    }
  }

  private clearAudioBuffer(): void {
    this.audioBufferQueue = [];
    this.audioBufferedMs = 0;
  }

  /**
   * Feed a fragment of the assistant's transcript to drive the mouth shapes.
   *
   * This is the primary lip-sync source: Gemini gives us the text of what
   * Manglara is saying, and Spanish spelling maps to phonemes reliably, so the
   * mouth can form the actual sounds instead of guessing them from the audio
   * waveform (see lipsync-es.ts).
   *
   * The fragments form a contiguous description of the turn's audio, and that -
   * not their arrival time - is what places them on the timeline. `audioFedMs` is
   * passed only as an upper bound; see viseme-driver.
   */
  feedTranscript(text: string): void {
    if (!this.head || !this.streaming) return;
    const units = spanishTextToUnits(text);
    if (!units.length) return;

    if (!this.textVisemesActive) {
      this.textVisemesActive = true;
      console.log("[lipsync] transcript-driven visemes active (HeadAudio muted)");
    }
    // The driver places this on the audio timeline itself, continuing where the
    // previous fragment's speech ended, and plays it when PLAYBACK reaches that
    // position. That is what puts mouth and voice together, instead of mouthing
    // text the moment it arrives (seconds early, since Gemini bursts far ahead of
    // playback).
    this.driver.enqueue(units, this.audioFedMs);
    this.recTextMs += unitsDuration(units);
    this.record("tx");
  }

  private record(kind: "tx" | "au"): void {
    if (!this.rec) return;
    this.rec.push({
      at: performance.now() - this.recStart,
      kind,
      fed: this.audioFedMs,
      textMs: this.recTextMs,
      heard: this.playedMs,
    });
  }

  /**
   * Start/stop capturing the live timeline. `window.__lipsyncRecord()` then
   * `window.__lipsyncReport()` after a few sentences.
   */
  recordTimeline(on = true): void {
    this.rec = on ? [] : null;
    this.recStart = performance.now();
    this.recTextMs = 0;
    console.log(`[lipsync] captura ${on ? "iniciada - habla unas frases" : "detenida"}`);
  }

  /**
   * The decisive number is `texto/audio`: how much speech the transcripts have
   * described versus how much audio has been delivered. Near 1 means they are
   * content-aligned and only pacing matters. Persistently below 1 means the
   * transcript trails its own audio, and then NO pacing scheme can be in sync -
   * the audio would have to be delayed to give the transcript a head start.
   */
  reportTimeline(): string {
    if (!this.rec || !this.rec.length) return "sin captura: llama a __lipsyncRecord() primero";
    const tx = this.rec.filter((r) => r.kind === "tx");
    const lines = tx.map((r) => {
      const ratio = r.fed > 0 ? r.textMs / r.fed : 0;
      // `adelanto` is the headroom the transcript has: how far the speech it
      // describes runs ahead of what the ear has already heard. Positive means the
      // text arrived in time to be mouthed; persistently negative means it is
      // describing audio that already played, and then nothing can be in sync.
      const lead = r.textMs * this.driver.rate - r.heard;
      return (
        `  t=${(r.at / 1000).toFixed(2)}s  oido=${Math.round(r.heard)}ms  ` +
        `audio_entregado=${Math.round(r.fed)}ms  texto_acumulado=${Math.round(r.textMs)}ms  ` +
        `texto/audio=${ratio.toFixed(2)}  adelanto=${Math.round(lead)}ms`
      );
    });
    const au = this.rec.filter((r) => r.kind === "au");
    const maxFed = Math.max(0, ...this.rec.map((r) => r.fed));
    const resets = Object.entries(this.resetCounts)
      .map(([k, n]) => `${k}=${n}`)
      .join(" ");
    const last = tx[tx.length - 1]!;
    // Compare TOTALS at the end of the capture, not the values at the last
    // transcript event: a fragment legitimately arrives before its own audio, so
    // reading `fed` at that instant understates it.
    const overall = maxFed > 0 ? last.textMs / maxFed : 0;
    const burst = last.at > 0 ? maxFed / last.at : 0;

    // A clock that never leaves zero is not a lag measurement, it is a bug: the
    // ratio is only meaningful once audio_entregado actually accumulates.
    const verdict =
      maxFed === 0
        ? "audioFedMs NUNCA subió de 0 → feedAudio() no corre o el reloj se resetea. " +
          "Mira los resets y los chunks de audio de abajo, NO es una medida de desfase."
        : overall > 0.85
          ? "alineados: el problema es de ritmo"
          : "el transcript va POR DETRÁS de su audio: habría que retrasar el audio";

    const clock = this.haveMetrics
      ? `MEDIDO desde el worklet (latencia de salida ${Math.round(this.outputLatencyMs)}ms)`
      : "SIN DATOS del worklet - metrics no llegaron, revisa streamStart";

    return [
      `fragmentos de transcript: ${tx.length}   chunks de audio: ${au.length}`,
      `reloj de reproduccion: ${clock}`,
      `audioFedMs máximo visto: ${Math.round(maxFed)}ms   oido: ${Math.round(this.playedMs)}ms`,
      `tempo aprendido: ${this.driver.rate.toFixed(3)} (audio ms por ms estimado)`,
      `resets del reloj: ${resets || "ninguno"}`,
      `ráfaga de audio: ${burst.toFixed(1)}x tiempo real`,
      `RATIO GLOBAL texto/audio: ${overall.toFixed(2)}  (${verdict})`,
      "--- ultimos chunks de audio ---",
      ...au
        .slice(-8)
        .map(
          (r) =>
            `  t=${(r.at / 1000).toFixed(2)}s  fed=${Math.round(r.fed)}ms  oido=${Math.round(r.heard)}ms`
        ),
      "--- ultimos fragmentos de transcript ---",
      ...lines.slice(-12),
    ].join("\n");
  }

  /**
   * Advance the mouth one frame. Called from `opt.update`, which TalkingHead
   * runs immediately before it applies morph targets.
   */
  private updateVisemes(dt: number): void {
    const head = this.head;
    if (!head) return;

    // Debug pin (window.__hold) overrides everything so a single shape can be
    // inspected on screen for as long as needed.
    if (this.heldViseme !== null) {
      this.textInCharge = true;
      this.writeVisemeMorphs(this.heldViseme);
      return;
    }

    // Audio-free preview (window.__say), pinned to natural pace.
    if (this.dryRun) {
      const backlog = this.driver.backlogMs;
      if (backlog <= 0) {
        this.dryRun = false;
        this.textInCharge = false;
        this.writeVisemeMorphs(null);
        return;
      }
      this.textInCharge = true;
      this.writeVisemeMorphs(
        this.driver.tick({
          dt,
          speaking: true,
          // No real audio: let the playback clock run free at natural pace.
          audioFedMs: Number.MAX_SAFE_INTEGER,
          naturalPace: true,
        })
      );
      this.runActions(this.motion.update(dt, this.driver.consumeBeats()));
      return;
    }

    // `isSpeaking` only gates whether the mouth may move at all. It is set the
    // instant a chunk is POSTED to the worklet, well before a sample is rendered,
    // so it must never be the timing source - the measured clock below stays at 0
    // until audio is genuinely consumed, which is what stops the mouth starting
    // ahead of the voice.
    const speaking = head.isSpeaking === true;
    let shape: string | null = null;
    let source: string;

    // Track how long the transcript schedule has been exhausted while audio is
    // still playing. Gemini transcribes audio it has ALREADY generated, so the
    // text can run out mid-phrase; holding the last shape there is exactly what
    // reads as the mouth freezing/stuttering against the voice.
    const textDry = this.textVisemesActive && this.driver.pendingMs <= 0;
    if (speaking && textDry) this.dryMs += dt;
    else this.dryMs = 0;
    // Hysteresis: only hand over once it has been dry for a while, so the
    // ordinary gaps between fragments don't flip drivers several times a second
    // (swapping between two very different sources is what feels artificial).
    const handOver = speaking && this.dryMs >= HANDOVER_AFTER_DRY_MS;

    // Transcript-driven is the accurate path: it forms the actual phonemes. The
    // audio FFT only approximates vowels from spectral energy, so it is used
    // solely when there is no transcript, or the transcript has run dry.
    if (this.textVisemesActive && !handOver) {
      // Shapes from the transcript, TIMING from the audio's own syllable beats
      // (see tickAnchored). An averaged tempo alone puts each syllable where the
      // average says rather than where it is actually spoken, which is why it
      // never read as real lip-sync however well the tempo was calibrated.
      const rms = this.readPlaybackRms();
      if (rms !== null) {
        source = "transcript+beats";
        shape = this.driver.tickAnchored({
          dt,
          rms,
          speaking,
          playedMs: this.measurePlayback(),
        });
      } else {
        // No analyser (setup failed): fall back to the averaged clock.
        source = "transcript";
        shape = this.driver.tick({
          dt,
          speaking,
          audioFedMs: this.audioFedMs,
          playedMs: this.measurePlayback(),
        });
      }
    } else if (speaking && this.analyserNode && this.freqData && this.timeData) {
      source = handOver ? "audio-fft(relevo)" : "audio-fft";
      this.analyserNode.getByteFrequencyData(this.freqData);
      this.analyserNode.getByteTimeDomainData(this.timeData);
      shape = this.driver.tickFrame({
        dt,
        frequencyData: this.freqData,
        timeDomainData: this.timeData,
      });
    } else {
      source = "idle";
      shape = this.driver.tick({
        dt,
        speaking,
        audioFedMs: this.audioFedMs,
        playedMs: this.measurePlayback(),
      });
    }

    // Gates HeadAudio's own morph writes (both target the same `newvalue` slot,
    // so only one may win per frame). Must be dynamic: a permanent mute would
    // leave the mouth frozen whenever the transcript lags or drops.
    this.textInCharge = source.startsWith("transcript");
    this.writeVisemeMorphs(shape);

    // Body language rides the same clock as the mouth, so a hand beat lands on
    // the clause the ear is hearing rather than on a timer of its own.
    this.runActions(this.motion.update(dt, this.driver.consumeBeats()));

    if (this.diagnose) {
      this.diagLastLog += dt;
      if (this.diagLastLog >= 250) {
        this.diagLastLog = 0;
        console.log(
          `[lipsync] ${speaking ? "AUDIO" : "silencio"} ` +
            `fuente=${source} ` +
            `forma=${shape ?? "-"} ` +
            `tempo=${this.driver.rate.toFixed(2)} ` +
            `silabas=${this.driver.beatCount} ` +
            `oido=${Math.round(this.playedMs)}ms ` +
            `entregado=${Math.round(this.audioFedMs)}ms`
        );
      }
    }
  }

  /**
   * Loudness of the audio being played right now, 0..1, or null if the analyser
   * isn't wired. This is the signal the syllable-beat detector runs on, read
   * from the same graph the ear hears, so the beats it finds are the real ones.
   */
  private readPlaybackRms(): number | null {
    const analyser = this.analyserNode;
    const buf = this.timeData;
    if (!analyser || !buf) return null;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i]! - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  /** Drop all pending mouth shapes and reset the lip-sync clock. */
  private resetVisemeState(why: string): void {
    this.resetCounts[why] = (this.resetCounts[why] ?? 0) + 1;
    this.clearAudioBuffer();
    this.driver.reset();
    this.audioFedMs = 0;
    this.textInCharge = false;
    this.dryMs = 0;
    // The playback clock is relative to `audioFedMs`, so it has to go with it.
    this.syncPlayedMs = 0;
    this.syncAt = 0;
    this.playedMs = 0;
    this.haveMetrics = false;
  }

  /** Signal the current utterance is complete (playback drains then idles). */
  notifyEnd(): void {
    if (!this.streaming) return;
    // Distinguishes a real end of turn from a mid-sentence buffer underrun:
    // both surface as `onAudioEnd`, but only here may leftover shapes be
    // dropped. Carrying them into the next turn would desync it from the start.
    this.turnEnded = true;
    this.flushAudioBuffer();
    this.head?.streamNotifyEnd();
  }

  /**
   * Debug helper (exposed as `window.__sayTest`): mouth the given text with
   * SILENT audio, so lip readability can be judged without a Gemini call.
   * Silence keeps TalkingHead's stream clock running, which is what the viseme
   * schedule is anchored to.
   */
  async testLipsync(text: string): Promise<void> {
    if (!this.head) return;
    if (!this.streaming) await this.startStream();
    const units = spanishTextToUnits(text);
    const total = unitsDuration(units);
    console.log(
      "[lipsync] test:",
      units.map((u) => u.viseme ?? "_").join(" "),
      `${Math.round(total)}ms`
    );
    // Transcript first, then its audio - the order Gemini sends them in.
    this.feedTranscript(text);
    const samples = Math.ceil(((total + 400) * GEMINI_SAMPLE_RATE) / 1000);
    this.feedAudio(new ArrayBuffer(samples * 2));
    this.notifyEnd();
  }

  /**
   * Mouth a phrase with NO audio (window.__say). Needs only the loaded avatar:
   * no AudioContext, no mic, no Gemini session. Resolves when the mouth is done,
   * so a caller can chain phrases.
   */
  say(text: string): Promise<void> {
    const units = spanishTextToUnits(text);
    if (!units.length || !this.head) return Promise.resolve();
    this.heldViseme = null;
    this.driver.reset();
    this.textVisemesActive = true;
    this.driver.enqueue(units);
    this.dryRun = true;
    // The body too, so `__say` previews the whole performance and not just the
    // mouth - which is the only way to judge the gesture timing without a call.
    this.currentState = "speaking";
    this.motion.start();
    const totalMs = unitsDuration(units);
    return new Promise((resolve) => {
      const started = performance.now();
      const check = (): void => {
        // Wait for the queue to drain, with a ceiling in case rendering stalls
        // (the avatar's animation loop only runs while the tab is visible).
        if (!this.dryRun || performance.now() - started > totalMs + 2000) {
          this.currentState = this.lastState ?? "idle";
          this.runActions(this.motion.stop());
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  /** Viseme ids available to `hold()`, in articulation order. */
  static readonly VISEMES = [
    "sil", "PP", "FF", "TH", "DD", "nn", "kk", "CH", "SS", "RR",
    "aa", "E", "I", "O", "U",
  ];

  /** Pin one viseme on screen, or null to release. */
  hold(viseme: string | null): void {
    this.dryRun = false;
    this.heldViseme = viseme;
  }

  /** The viseme sequence a phrase produces, for comparing against the mouth. */
  phonemesOf(text: string): string {
    return spanishTextToUnits(text)
      .map((u) => u.viseme ?? "·")
      .join(" ");
  }

  /**
   * Barge-in: drop everything queued for this turn.
   *
   * Gemini streams audio far ahead of playback, so on an interruption there is a
   * lot of already-delivered audio AND a matching pile of pending mouth shapes
   * that are now both cancelled. Without this the buffered audio keeps playing
   * while the mouth works through its stale queue, and since neither clock is
   * reset the desync persists for the rest of the session and compounds with
   * every further interruption.
   */
  interrupt(): void {
    if (!this.streaming) return;
    console.warn("[lipsync] interrupt(): descartando el turno en curso");
    this.turnEnded = false;
    this.clearAudioBuffer();
    this.head?.streamInterrupt(); // stops playback and purges queued visemes
    this.resetVisemeState("interrupted");
    this.writeVisemeMorphs(null); // release the shape being held
  }

  /** Leave streaming mode (keeps the avatar mounted and idle). */
  stopStream(): void {
    if (!this.streaming) return;
    this.clearAudioBuffer();
    this.head?.streamStop();
    this.streaming = false;
    this.resetVisemeState("stopStream");
    this.textVisemesActive = false;
    this.runActions(this.motion.stop());
  }

  // --- state, expression and motion ----------------------------------------

  /** Map the call state machine to gaze, facial mood and body language. */
  setState(state: AvatarState): void {
    const head = this.head;
    if (!head || !this._ready || state === this.lastState) return;
    this.lastState = state;
    this.currentState = state;
    if (state === "thinking") {
      // Keep eye contact while thinking; only the mood and body motion change.
      this.setMood(THINKING_MOOD);
      head.lookAtCamera(500);
      this.runActions(this.motion.stop());
    } else if (state === "speaking") {
      // Warm and animated while presenting: eye contact plus the "happy" mood's
      // speaking animation (brows, head-sway, micro-mouth), with the body
      // directed from the speech itself (see motion-director).
      this.setMood(DEFAULT_MOOD);
      head.makeEyeContact(3000);
      this.motion.start();
    } else {
      // idle / listening: attentive, smiling, looking at the user, with a single
      // gentle lean-in so she reads as actively listening.
      this.setMood(DEFAULT_MOOD);
      head.lookAtCamera(500);
      this.runActions(this.motion.stop());
      this.playGestureBeat(null, "leanIn", false, 2500, 800);
    }
  }

  /**
   * Follow the user's pointer with her head and gaze.
   *
   * Call this from a `pointermove` listener on the avatar container (or the
   * call-screen wrapper). The coordinates are standard `PointerEvent.clientX/Y`
   * — visual-viewport pixels, exactly what `TalkingHead.lookAt(x, y, t)` expects.
   *
   * Only acts while she is in a passive state (`idle` / `listening`). While she
   * is `speaking` she already maintains eye contact via `makeEyeContact`, and
   * while `thinking` the glance-away is intentional — both must not be interrupted
   * by a stray mouse move.
   *
   * Throttled to `POINTER_THROTTLE_MS` so that restarting the look-at transition
   * on every 120 Hz pointer event doesn't cancel it before it completes.
   */
  trackPointer(x: number, y: number): void {
    if (!this.head || !this._ready) return;
    if (!POINTER_TRACK_STATES.has(this.currentState)) return;
    const now = performance.now();
    if (now - this.lastPointerLookAt < POINTER_THROTTLE_MS) return;
    this.lastPointerLookAt = now;
    try {
      this.head.lookAt(x, y, POINTER_LOOK_DUR_MS);
    } catch {
      // Non-fatal: the camera may not be mounted yet, or the method may be
      // absent on an older library version.
    }
  }

  /** Execute what the director decided this frame. */
  private runActions(actions: MotionAction[]): void {
    for (const action of actions) {
      switch (action.kind) {
        case "gesture":
          this.playGestureBeat(
            action.arm,
            action.torso,
            action.mirror,
            action.holdMs,
            action.easeMs
          );
          break;
        case "accent":
          // Raise rather than set: two accents close together should stack a
          // little, the way a speaker leans into a run of emphasis.
          this.emphasisTarget = Math.min(1, this.emphasisTarget + action.strength);
          // The stroke starts from where the head IS, so an accent landing while
          // the previous one is still decaying stays continuous.
          this.accentFrom = { ...this.headAccent };
          this.accentTo = { x: action.nod, y: action.turn, z: action.tilt };
          this.accentAttack = 0;
          break;
        case "blink":
          this.blinkMs = BLINK_CLOSE_MS + BLINK_OPEN_MS;
          break;
        case "relax":
          try {
            this.head?.stopGesture(GESTURE_RELAX_MS);
          } catch {
            // ignore
          }
          break;
      }
    }
  }

  /**
   * Register the torso body-language poses (see motion-director's
   * BODY_GESTURES) into TalkingHead's gestureTemplates. They rotate only
   * Spine1/Spine2/Neck/Head, which deform cleanly on this rig.
   */
  private registerBodyLanguage(head: TalkingHead): void {
    if (!head.gestureTemplates) return;
    for (const [name, tmpl] of Object.entries(BODY_GESTURES)) {
      head.gestureTemplates[name] = tmpl as Record<string, unknown>;
    }
  }

  /**
   * The rest rotation of every joint a beat can move, read off the pose template
   * while no gesture is playing.
   *
   * Read once, at load: `getPoseTemplateProp` returns the value of the CURRENT
   * gesture for any joint that gesture holds, so asking later would capture a
   * pose rather than the rest position. Both sides of every limb are collected,
   * because `playGesture(..., mirror)` renames `Left*` to `Right*` and back.
   */
  private captureRestPose(head: TalkingHead): void {
    const keys = new Set<string>();
    const add = (key: string): void => {
      const [bone, kind] = key.split(".");
      if (!bone || (kind !== "rotation" && kind !== "quaternion")) return;
      keys.add(`${bone}.quaternion`);
      if (bone.startsWith("Left")) keys.add(`Right${bone.slice(4)}.quaternion`);
      else if (bone.startsWith("Right")) keys.add(`Left${bone.slice(5)}.quaternion`);
    };
    for (const name of new Set(ARM_GESTURES)) {
      for (const key of Object.keys(head.gestureTemplates?.[name] ?? {})) add(key);
    }
    for (const tmpl of Object.values(BODY_GESTURES)) {
      for (const key of Object.keys(tmpl)) add(key);
    }

    const rest: Record<string, { x: number; y: number; z: number; w: number }> = {};
    for (const key of keys) {
      const q = head.getPoseTemplateProp?.(key) as Quaternion | undefined;
      if (!q || typeof q.w !== "number") continue;
      rest[key] = { x: q.x, y: q.y, z: q.z, w: q.w };
    }
    this.restProps = rest;
    if (!Object.keys(rest).length) {
      console.warn("[avatar] sin pose de reposo: los gestos no volverán solos");
    }
  }

  /**
   * Play one whole-body beat: an arm pose (or none) plus a torso pose, as a
   * SINGLE gesture.
   *
   * It has to be single, and it has to name every joint, because of how
   * TalkingHead holds a gesture. `playGesture` replaces `this.gesture` wholesale
   * and `stopGesture` restores only the props of the gesture it is currently
   * holding - so a torso beat played on top of an arm pose drops the arm props
   * on the floor: nothing ever returns them, and the arms stay frozen halfway
   * through the previous pose until some unrelated animation happens to move
   * them. Spreading `restProps` first means every joint is either posed by this
   * beat or explicitly sent home by it.
   *
   * The rest values are `.quaternion` keys and the templates are `.rotation`
   * keys; `propsToThreeObjects` folds both onto `.quaternion`, later wins, so
   * the template overrides the rest value for the joints it mentions.
   */
  private playGestureBeat(
    arm: string | null,
    torso: string,
    mirror: boolean,
    holdMs = 1500,
    easeMs = 700
  ): void {
    const head = this.head;
    if (!head?.gestureTemplates) return;
    const merged = {
      ...this.restProps,
      ...(arm ? (head.gestureTemplates[arm] ?? {}) : {}),
      ...(BODY_GESTURES[torso] ?? {}),
    };
    head.gestureTemplates[GESTURE_BEAT_NAME] = merged as Record<string, unknown>;
    try {
      head.playGesture(GESTURE_BEAT_NAME, holdMs / 1000, mirror, easeMs);
    } catch {
      // Build mismatch / missing bone: skip rather than break the call.
    }
  }

  /** Set the facial mood (face + head-sway only; never touches the body rig). */
  setMood(mood: string): void {
    const head = this.head;
    if (!head) return;
    try {
      head.setMood(mood);
    } catch {
      // Unknown mood name (build mismatch): keep the current face rather than throw.
    }
  }

  /**
   * Brows, eyes and cheeks for the conversational state.
   *
   * Deliberately does NOT touch the mouth: `writeVisemeMorphs` and the mood's
   * own micro-mouth own every `viseme_*` and `mouth*` morph. Two writers on one
   * morph means whichever runs second wins and the other silently does nothing.
   *
   * The brow accent is not on a timer of its own: it is raised by the stressed
   * syllables the lip-sync clock crosses, so an eyebrow lifts on a word she is
   * actually emphasising.
   */
  private updateFacialExpressions(dt: number): void {
    const head = this.head;
    if (!head || !this._ready) return;

    const targets: Record<string, number> = {
      browInnerUp: 0,
      browOuterUpLeft: 0,
      browOuterUpRight: 0,
      browDownLeft: 0,
      browDownRight: 0,
      eyeSquintLeft: 0,
      eyeSquintRight: 0,
      eyeWideLeft: 0,
      eyeWideRight: 0,
      cheekSquintLeft: 0,
      cheekSquintRight: 0,
    };

    // The target decays; the value the rig sees chases it. Two stages, because
    // an accent that is only a decay has no rise: the brow would appear at its
    // new height in one frame, which reads as a flicker, not as emphasis.
    this.emphasisTarget *= 1 - Math.min(1, dt / EMPHASIS_DECAY_MS);
    this.emphasisValue +=
      (this.emphasisTarget - this.emphasisValue) * Math.min(1, dt / EMPHASIS_ATTACK_MS);

    if (this.currentState === "speaking") {
      targets.eyeSquintLeft = 0.2;
      targets.eyeSquintRight = 0.2;
      targets.cheekSquintLeft = 0.18;
      targets.cheekSquintRight = 0.18;
      targets.browInnerUp = 0.25 + this.emphasisValue * 0.5;
      targets.browOuterUpLeft = 0.15 + this.emphasisValue * 0.35;
      targets.browOuterUpRight = 0.15 + this.emphasisValue * 0.35;
    } else if (this.currentState === "thinking") {
      targets.browInnerUp = 0.48;
      targets.browDownLeft = 0.38;
      targets.browDownRight = 0.2;
      targets.eyeSquintLeft = 0.15;
    } else {
      // idle / listening: attentive and receptive.
      targets.eyeWideLeft = 0.16;
      targets.eyeWideRight = 0.16;
      targets.browInnerUp = 0.22;
    }

    const lerpSpeed = Math.min(1, dt / FACIAL_RESPONSE_MS);
    for (const [k, targetVal] of Object.entries(targets)) {
      const cur = this.facialMorphs[k] ?? 0;
      const next = cur + (targetVal - cur) * lerpSpeed;
      this.facialMorphs[k] = next;
      this.setAnimationMorph(k, next);
    }
  }

  /**
   * Advance the head accent and add it to the Head bone, and run any directed
   * blink.
   *
   * See HEAD_ACCENT_ATTACK_MS for why this goes on the bone rather than into
   * `headRotateX/Y/Z`. Post-multiplied in the same Euler order the library uses
   * for its own head pose delta, so the two compose exactly as if this were one
   * more term in it - the idle head movement keeps running underneath.
   */
  private updateHeadAccent(dt: number): void {
    const head = this.head;
    if (!head) return;

    if (this.blinkMs > 0) {
      this.blinkMs = Math.max(0, this.blinkMs - dt);
      const closed =
        this.blinkMs > BLINK_OPEN_MS
          ? 1 - (this.blinkMs - BLINK_OPEN_MS) / BLINK_CLOSE_MS
          : this.blinkMs / BLINK_OPEN_MS;
      const v = this.blinkMs === 0 ? null : Math.min(1, Math.max(0, closed));
      // Released back to null at the end so the library's own blink timer takes
      // the lids again instead of finding them pinned open.
      this.setRealtimeMorph("eyeBlinkLeft", v);
      this.setRealtimeMorph("eyeBlinkRight", v);
    }

    const a = this.headAccent;
    if (this.accentAttack < 1) {
      this.accentAttack = Math.min(1, this.accentAttack + dt / HEAD_ACCENT_ATTACK_MS);
      // Smoothstep: zero velocity at both ends, so the stroke has no corner at
      // the start and none where it hands over to the decay.
      const k = this.accentAttack * this.accentAttack * (3 - 2 * this.accentAttack);
      a.x = this.accentFrom.x + (this.accentTo.x - this.accentFrom.x) * k;
      a.y = this.accentFrom.y + (this.accentTo.y - this.accentFrom.y) * k;
      a.z = this.accentFrom.z + (this.accentTo.z - this.accentFrom.z) * k;
    } else {
      const decay = Math.exp(-dt / HEAD_ACCENT_TAU_MS);
      a.x *= decay;
      a.y *= decay;
      a.z *= decay;
    }
    const bone = this.headBone;
    if (!bone) return;
    const spent =
      this.accentAttack >= 1 && Math.abs(a.x) + Math.abs(a.y) + Math.abs(a.z) < 0.002;

    // Take last frame's accent back off before adding this one.
    //
    // The accent is a delta on whatever the pose left on the bone, and it has to
    // be, so the library's idle head movement keeps running underneath it. But
    // `updatePoseDelta` SKIPS any joint whose delta is all zeros, and the head's
    // usually is - so on those frames the bone still holds what we wrote last
    // frame, and post-multiplying again integrates the accent instead of
    // replacing it. Measured before this guard: ten accents wound the head round
    // to 3.05 rad and it never came back.
    //
    // Comparing against what we left is what makes this safe both ways: if the
    // quaternion still matches, nobody else has touched it and our delta has to
    // come off; if it differs, the pose was rewritten this frame and the bone is
    // already clean.
    if (this.accentHolds && bone.quaternion.equals(this.accentWritten)) {
      bone.quaternion.copy(this.accentPose);
    }
    if (spent) {
      a.x = 0;
      a.y = 0;
      a.z = 0;
      this.accentHolds = false;
      return; // identity: the bone is back on the pose, nothing to add
    }

    this.accentPose.copy(bone.quaternion);
    // 'XYZ', matching `updatePoseDelta`: positive x dips the chin.
    this.accentEuler.set(a.x, a.y, a.z, "XYZ");
    this.accentDelta.setFromEuler(this.accentEuler);
    bone.quaternion.multiply(this.accentDelta);
    this.accentWritten.copy(bone.quaternion);
    this.accentHolds = true;
  }

  /**
   * Keep her eyes alive and on the user.
   *
   * TalkingHead already decides WHERE she looks - `lookAtCamera` / `makeEyeContact`
   * put her gaze on the user and `lookAhead` takes it away while she thinks - and
   * on this rig that gaze reaches the eyeballs through the ARKit `eyeLook*`
   * morphs (the `LeftEye`/`RightEye` bones added by fix_shapeskey_glb.py are
   * unskinned, so rotating them moves nothing). What is missing is that between
   * its saccades the gaze is perfectly still, which is most of what reads as a
   * doll rather than a person.
   *
   * So this reads the gaze the animation pass just wrote, adds a slow wander and
   * the pitch trim, and writes it back at realtime priority - which is the same
   * decomposition the library itself uses (see `setBaselineValue('eyesRotateY')`).
   */
  private updateGaze(dt: number): void {
    const head = this.head;
    if (!head) return;
    this.eyeClock += dt / 1000;

    // What the animation decided for this frame. `newvalue` is this frame's
    // value and has not been consumed yet (opt.update runs before
    // updateMorphTargets); `value` is what is currently on the meshes.
    const read = (k: string): number => {
      const mt = head.mtAvatar[k] as
        | { newvalue?: number | null; value?: number | null }
        | undefined;
      if (!mt) return 0;
      const v = mt.newvalue ?? mt.value ?? 0;
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };

    // Both eyes share one direction: the library's mapping pairs "out" on one
    // eye with "in" on the other, so they track together.
    let yaw = read("eyeLookOutLeft") - read("eyeLookInLeft");
    let pitch = read("eyesLookDown") - read("eyesLookUp") - EYE_PITCH_TRIM;

    const t = this.eyeClock;
    yaw += EYE_WANDER_YAW * (Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.83) * 0.4);
    pitch += EYE_WANDER_PITCH * (Math.sin(t * 0.29) * 0.6 + Math.sin(t * 0.61) * 0.4);
    yaw = Math.max(-EYE_MAX_YAW, Math.min(EYE_MAX_YAW, yaw));
    pitch = Math.max(-EYE_MAX_PITCH, Math.min(EYE_MAX_PITCH, pitch));

    this.setRealtimeMorph("eyeLookOutLeft", yaw > 0 ? yaw : 0);
    this.setRealtimeMorph("eyeLookInLeft", yaw > 0 ? 0 : -yaw);
    this.setRealtimeMorph("eyeLookOutRight", yaw > 0 ? 0 : -yaw);
    this.setRealtimeMorph("eyeLookInRight", yaw > 0 ? yaw : 0);
    this.setRealtimeMorph("eyesLookDown", pitch > 0 ? pitch : 0);
    this.setRealtimeMorph("eyesLookUp", pitch > 0 ? 0 : -pitch);
    this.gazeHeld = true;
  }

  /** Hand the gaze morphs back to the library (teardown / stream end). */
  private releaseGaze(): void {
    if (!this.gazeHeld) return;
    for (const k of GAZE_MORPHS) this.setRealtimeMorph(k, null);
    this.gazeHeld = false;
  }

  /**
   * Write one morph in the real-time slot, or release it with `null`.
   *
   * `realtime` outranks `system`, `newvalue` and `baseline` and is applied
   * without easing. It is NOT cleared after use, so releasing has to be explicit.
   */
  private setRealtimeMorph(k: string, val: number | null): void {
    const mt = this.head?.mtAvatar[k] as
      | { realtime?: number | null; needsUpdate?: boolean }
      | undefined;
    if (!mt) return;
    mt.realtime = val;
    mt.needsUpdate = true;
  }

  /** Write one morph at animation priority (used by the expression pass). */
  private setAnimationMorph(k: string, val: number): void {
    const mt = this.head?.mtAvatar[k];
    if (!mt) return;
    mt.newvalue = val;
    mt.needsUpdate = true;
  }

  /**
   * Grab the bones driven by hand once. Only the head is needed on this rig:
   * the eye bones are unskinned (see updateGaze), so gaze goes through morphs.
   */
  private captureBones(head: TalkingHead): void {
    this.headBone = null;
    const root = (head as unknown as { armature?: Object3D }).armature;
    root?.traverse((o) => {
      const b = o as Bone;
      if (b.isBone && b.name === "Head") this.headBone = b;
    });
    if (!this.headBone) {
      console.warn("[avatar] sin hueso Head — los acentos de cabeza no se verán");
    }
  }

  dispose(): void {
    this.disposed = true;
    this.runActions(this.motion.stop());
    this.releaseGaze();
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
    this.mouthTex?.dispose();
    this.mouthMesh = null;
    this.mouthCtx = null;
    this.mouthTex = null;
    this.lastShape = null;
    this.headAudio = null;
    this.headAudioReady = false;
    this.head = null;
    this._ready = false;
  }

  /**
   * Pull the stage exposure down to what this character's textures were painted
   * for. See TONE_MAPPING_EXPOSURE.
   *
   * `renderer` and `scene` are runtime properties the typings do not surface,
   * hence the structural cast; both are non-fatal if a build ever drops them.
   */
  private gradeScene(head: TalkingHead): void {
    const th = head as unknown as {
      scene?: { environmentIntensity?: number };
      renderer?: { toneMappingExposure?: number };
    };
    if (th.renderer) th.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    // The IBL is the diffuse fill; the per-material ENV_MAP_INTENSITY below only
    // scales the reflection each surface takes from it.
    if (th.scene) th.scene.environmentIntensity = 0.9;
  }

  /**
   * Adjust material settings once the avatar is loaded.
   */
  private dampenMaterials(head: TalkingHead): void {
    const root = (head as unknown as { armature?: Mesh }).armature;
    if (!root) return;
    const seen = new Set<string>();
    const isStandard = (m: Material): m is MeshStandardMaterial =>
      "roughness" in m && "metalness" in m;
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (seen.has(m.uuid) || !isStandard(m)) continue;
        seen.add(m.uuid);
        // The scene's HDR reflection is the same on every surface, eyes included.
        m.envMapIntensity = ENV_MAP_INTENSITY;
        m.needsUpdate = true;
      }
    });
  }

  /** Find the MouthOverlay patch exported by the rig pipeline and give it a
   *  CanvasTexture we can repaint per frame. Non-fatal if missing (older GLB). */
  private setupMouthSprite(head: TalkingHead): void {
    try {
      const root = (head as unknown as { armature?: Mesh }).armature;
      let overlay: Mesh | null = null;
      root?.traverse?.((o) => {
        if ((o as Mesh).isMesh && o.name === "MouthOverlay") overlay = o as Mesh;
      });
      if (!overlay) {
        console.warn("[mouth] MouthOverlay mesh not found in avatar GLB");
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const tex = new CanvasTexture(canvas);
      tex.colorSpace = SRGBColorSpace;
      tex.flipY = false; // glTF UV convention (v=0 at the top of the patch)
      (overlay as Mesh).material = new MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      });
      (overlay as Mesh).renderOrder = 2;
      this.mouthMesh = overlay;
      this.mouthCtx = ctx;
      this.mouthTex = tex;
      // Expose for manual debugging in the console.
      (window as unknown as Record<string, unknown>).__drawMouth = () => this.drawMouth();
      console.log("[mouth] sprite overlay ready");
    } catch (error) {
      console.warn("[mouth] sprite setup failed:", error);
    }
  }

  /** Repaint the mouth sprite from the overlay's CURRENT morph influences
   *  (already eased by TalkingHead, so the sprite is perfectly in sync with
   *  the jaw/chin deformation). Called every render frame via opt.update. */
  private drawMouth(): void {
    const mesh = this.mouthMesh;
    const ctx = this.mouthCtx;
    const tex = this.mouthTex;
    if (!mesh || !ctx || !tex) return;
    const dict = mesh.morphTargetDictionary;
    const inf = mesh.morphTargetInfluences;
    if (!dict || !inf) return;
    const v = (k: string): number => {
      const i = dict[k];
      return i === undefined ? 0 : inf[i] ?? 0;
    };

    // Use the organically LERP-interpolated lip shape computed by AudioVisemeEngine
    const shape = this.driver.currentLipShape ?? blendLipShapes((viseme) => v(`viseme_${viseme}`));

    // Skip the repaint when nothing moved perceptibly.
    if (
      this.lastShape &&
      Math.abs(shape.aperture - this.lastShape.aperture) < 0.006 &&
      Math.abs(shape.width - this.lastShape.width) < 0.01 &&
      Math.abs(shape.round - this.lastShape.round) < 0.02 &&
      Math.abs(shape.protrude - this.lastShape.protrude) < 0.02 &&
      Math.abs(shape.upperTeeth - this.lastShape.upperTeeth) < 0.03 &&
      Math.abs(shape.tongue - this.lastShape.tongue) < 0.04 &&
      Math.abs(shape.lipOnTeeth - this.lastShape.lipOnTeeth) < 0.02
    ) {
      return;
    }
    this.lastShape = shape;

    // Canvas space: the pipeline maps the painted lip line to a constant
    // v = 0.375 from the top of the patch, so a straight sprite follows the
    // smile curve on the mesh automatically.
    const W = 512;
    const H = 256;
    const cx = W / 2;
    const lineY = 0.375 * H;
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = "round";

    const { aperture, width, round, protrude, tongue, lipOnTeeth } = shape;

    // /f/ and /v/: the lips barely part, so the identifying cue has to be drawn
    // even though aperture is tiny - upper teeth biting the lower lip.
    if (aperture <= 0.03 && lipOnTeeth <= 0.03) {
      tex.needsUpdate = true; // sealed: the painted lips already read correctly
      return;
    }

    // Aperture outline. Corners sit on the painted lip line; `round` pulls them
    // inward and `protrude` shrinks the hole to a pucker.
    const hw = W * (0.18 + 0.22 * width) * (1 - 0.22 * protrude);
    const up = aperture * (0.09 + 0.13 * round) * H;
    const down = aperture * (0.34 + 0.12 * round) * H;
    const corner = 1 - 0.55 * round; // how far the curve reaches the corners
    const openH = up + down; // height of the aperture; drives the interior layout

    const path = new Path2D();
    path.moveTo(cx - hw, lineY);
    path.bezierCurveTo(cx - hw * corner, lineY - up, cx + hw * corner, lineY - up, cx + hw, lineY);
    path.bezierCurveTo(cx + hw * corner, lineY + down, cx - hw * corner, lineY + down, cx - hw, lineY);

    // Lip outline FIRST, so the fills below cover its inner half and only the
    // outer half shows. Stroking last instead ate 3px inward all the way round -
    // on a thin aperture like /s/ (17px tall) that is a third of the opening
    // turned black, burying the teeth and tongue and reading as an empty hole.
    ctx.strokeStyle = "rgba(72, 27, 16, 0.92)";
    ctx.lineWidth = 6 + 9 * protrude;
    ctx.stroke(path);

    const cavity = ctx.createLinearGradient(0, lineY - up, 0, lineY + down);
    cavity.addColorStop(0, "#42150f");
    cavity.addColorStop(1, "#1e0806");
    ctx.fillStyle = cavity;
    ctx.fill(path);

    ctx.save();
    ctx.clip(path);

    // The tongue is ALWAYS there in an open mouth - what varies is how high it
    // rises (tip at the alveolar ridge for /t/, /d/, /n/, /l/; low and flat for
    // /a/). Gating it on a low `tongue` value left wide vowels as an empty black
    // hole, and centring the ellipse below the cavity floor meant the clip threw
    // nearly all of it away. Draw it as a mass rising from the floor instead.
    const tongueTop = lineY + down - openH * (0.36 + 0.42 * tongue);
    const tg = ctx.createLinearGradient(0, tongueTop, 0, lineY + down);
    tg.addColorStop(0, "#c2685a");
    tg.addColorStop(1, "#8e3b33"); // shaded where it meets the floor
    ctx.fillStyle = tg;
    ctx.beginPath();
    const tongueH = lineY + down - tongueTop + 10;
    // Radii MUST be clamped to the box: a radius larger than half the height
    // collapses the shape. hw*0.5 is ~80px, so on a thin aperture the tongue and
    // the teeth bands were being rounded away almost entirely.
    const tongueR = Math.min(hw * 0.5, tongueH * 0.45);
    ctx.roundRect(cx - hw * 0.92, tongueTop, hw * 1.84, tongueH, [tongueR, tongueR, 6, 6]);
    ctx.fill();
    // Centre crease, the detail that stops it reading as a flat pink slab.
    ctx.strokeStyle = "rgba(110,40,34,0.45)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, tongueTop + openH * 0.06);
    ctx.lineTo(cx, lineY + down);
    ctx.stroke();

    // Teeth rows. Visibility differs per viseme and is a strong readability cue:
    // /s/ shows both rows nearly meeting, /o/ and /u/ hide them almost entirely.
    const enamel = "#f6f1e6";

    // Order matters: lower teeth, then the /f/ lip tuck, then the upper teeth
    // LAST. For /f/ and /v/ the teeth have to sit visibly ON the lower lip;
    // painting the lip afterwards buried them and made /f/ read as a shut mouth.
    if (shape.lowerTeeth > 0.05) {
      const th = openH * 0.2 * shape.lowerTeeth;
      const top = lineY + down - th;
      const tw = hw * 1.56;
      const grad = ctx.createLinearGradient(0, top, 0, top + th + 8);
      grad.addColorStop(0, "#fffdf7");
      grad.addColorStop(1, "#cdc2b1"); // shadowed towards the gum
      ctx.fillStyle = grad;
      ctx.beginPath();
      const r = Math.min(9, (th + 8) * 0.4); // clamped: see the tongue note below
      ctx.roundRect(cx - tw / 2, top, tw, th + 8, [r, r, 4, 4]);
      ctx.fill();
    }
    if (lipOnTeeth > 0.05) {
      ctx.globalAlpha = lipOnTeeth;
      ctx.fillStyle = "#8d3a2c";
      ctx.beginPath();
      ctx.roundRect(cx - hw, lineY + down - openH * 0.45, hw * 2, down + 12, 12);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (shape.upperTeeth > 0.05) {
      // Composition of an open mouth, as fractions of the aperture: a teeth band
      // at the top, dark in the middle, tongue filling the bottom. Scaling this
      // by the canvas height made a wide /a/ 73% teeth; shrinking it to a fixed
      // 22 px swung the other way and left the mouth looking empty.
      const th = openH * (0.14 + 0.32 * shape.upperTeeth);
      const top = lineY - up - 6;
      const h = th + 6;
      const tw = hw * 1.72;
      // A flat white rectangle reads as a blotch, not as teeth. A gum-line
      // shadow, a brighter biting edge and faint incisor gaps make it read.
      const grad = ctx.createLinearGradient(0, top, 0, top + h);
      grad.addColorStop(0, "#cbbfae");
      grad.addColorStop(0.4, enamel);
      grad.addColorStop(1, "#fffdf7");
      ctx.fillStyle = grad;
      ctx.beginPath();
      const r = Math.min(11, h * 0.4); // clamped: see the tongue note above
      ctx.roundRect(cx - tw / 2, top, tw, h, [4, 4, r, r]);
      ctx.fill();
      ctx.strokeStyle = "rgba(146,128,108,0.32)";
      ctx.lineWidth = 2;
      for (const f of [-0.28, -0.1, 0.1, 0.28]) {
        ctx.beginPath();
        ctx.moveTo(cx + tw * f, top + h * 0.4);
        ctx.lineTo(cx + tw * f, top + h);
        ctx.stroke();
      }
    }

    ctx.restore();

    tex.needsUpdate = true;
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

      // Fallback only. Transcript-driven visemes are far more legible, so
      // HeadAudio yields the mouth whenever text has something to say. It stays
      // wired for the cases text can't cover: transcription disabled, lagging
      // badly, or dropping mid-turn - otherwise the mouth would just freeze.
      let valueCount = 0;
      ha.onvalue = (key: string, value: number) => {
        if (this.textInCharge) return;
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
      // Bounded: this fires continuously while audio flows, and an unbounded
      // console.log on that path stalls the main thread enough to hitch the render
      // loop - which freezes the mouth mid-word. Verified flooding the console.
      let vadCount = 0;
      ha.onvad = (o: unknown) => {
        if (vadCount < 8) {
          vadCount++;
          log("onvad", o);
        }
      };

      // NOTE: opt.update is wired in init(), not here - the mouth must keep
      // working even if this whole HeadAudio setup fails.

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
