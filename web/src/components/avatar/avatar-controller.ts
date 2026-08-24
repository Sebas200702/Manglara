import type { AvatarState } from "@manglara/shared";
import { TalkingHead } from "@met4citizen/talkinghead";
import type {
  DynamicBoneConfig,
  PlaybackMetricsMessage,
} from "@met4citizen/talkinghead";
import {
  Bone,
  Color,
  Euler,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
} from "three";
// Statically bundle the English lip-sync processor. TalkingHead otherwise loads
// it via `import('./lipsync-en.mjs')` - an un-analyzable dynamic import that
// Rollup can't bundle, so in production it 404s at /assets/lipsync-en.mjs. We
// import it here (Vite bundles it) and register it on the instance below.
import { LipsyncEn } from "@met4citizen/talkinghead/modules/lipsync-en.mjs";
import { spanishTextToUnits, unitsDuration } from "./lipsync-es";
import { VisemeDriver } from "./viseme-driver";

/** Assistant audio from Gemini Live is 24 kHz, 16-bit LE PCM. */
const GEMINI_SAMPLE_RATE = 24000;

/**
 * Ceiling on how far any single viseme may be driven, before the per-viseme
 * calibration below.
 *
 * Talking is a small movement. This rig's `viseme_aa` drops the jaw 4 cm at
 * full weight, which is a yawn - conversational speech is nearer a third of
 * that. Started at 1.05 (every frame at full strength), then 0.78; both still
 * read as gaping on camera. Judge any change at the app's own framing, not on
 * a mouth close-up: filling the frame hides how large the movement is relative
 * to the face.
 */
const VISEME_LEVEL = 0.46;
/**
 * Softest the mouth may move while still audibly speaking. Without a floor the
 * quiet tail of a sentence stops moving the lips at all, which reads as the
 * audio continuing over a frozen face.
 */
const VISEME_LEVEL_MIN = 0.14;

/**
 * Per-viseme gain, because a morph weight of 1.0 does not mean the same thing
 * from one target to the next on this rig.
 *
 * `diag_morph_distinct.py` measures how far each viseme actually displaces the
 * mouth region. Normalised against `viseme_aa`: `O` moves 1.18x and `U` 1.12x -
 * *more* than the widest vowel - while `SS` moves 0.27x and `FF` 0.29x. Driving
 * them all at one level therefore gapes on every rounded vowel and does nothing
 * visible on the sibilants. Each gain is roughly the aperture the viseme should
 * read at (see LIP_SHAPES in lip-shapes.ts) divided by the travel it actually
 * has. Re-measure and retune if the designer redelivers the rig.
 */
/**
 * Extra morphs layered on top of each viseme, and how hard.
 *
 * The viseme targets on this rig are not as distinct as their names suggest:
 * `diag_morph_distinct.py` measures cosine 0.99 between `viseme_O`, `viseme_CH`
 * and `viseme_RR`, and 0.98 between `viseme_aa`, `viseme_nn`, `viseme_TH` and
 * `jawOpen`. Driving the viseme alone therefore produces a mouth that mostly
 * just opens and closes. The ARKit targets that *are* independent - pucker,
 * funnel, roll, press, stretch, the per-side smile - carry the articulation the
 * visemes lack, so each one gets a small chord of them instead of a single note.
 *
 * Deliberately avoids `mouthSmile`, `cheekSquint*` and the brow targets:
 * `updateFacialExpressions` owns those for the conversational state and the two
 * writers would fight over the same slot every frame.
 */
const VISEME_EXTRAS: Record<string, Record<string, number>> = {
  // Open vowel: let the jaw carry it rather than stretching the lips wider.
  // Kept modest - this stacks on top of viseme_aa, which already drops the jaw.
  aa: { jawOpen: 0.16, mouthLowerDownLeft: 0.12, mouthLowerDownRight: 0.12 },
  // Front vowels spread the corners. /i/ more than /e/.
  E: { mouthSmileLeft: 0.24, mouthSmileRight: 0.24, mouthStretchLeft: 0.18, mouthStretchRight: 0.18 },
  I: { mouthSmileLeft: 0.34, mouthSmileRight: 0.34, mouthStretchLeft: 0.3, mouthStretchRight: 0.3 },
  // Rounded back vowels. Funnel opens the ring, pucker pushes it forward.
  O: { mouthFunnel: 0.45, mouthPucker: 0.26 },
  U: { mouthPucker: 0.6, mouthFunnel: 0.3 },
  // /f/, /v/: lower lip rolled under the upper teeth - the one unmistakable
  // consonant shape, and worth spending morphs on.
  FF: { mouthRollLower: 0.45, mouthUpperUpLeft: 0.22, mouthUpperUpRight: 0.22 },
  // /s/: narrow slit, corners drawn back, teeth nearly meeting.
  SS: { mouthStretchLeft: 0.26, mouthStretchRight: 0.26, mouthClose: 0.16 },
  // Bilabial closure. Pressing and rolling both lips is what makes it read as
  // shut rather than merely small.
  PP: { mouthPressLeft: 0.5, mouthPressRight: 0.5, mouthRollLower: 0.2, mouthRollUpper: 0.2 },
  CH: { mouthPucker: 0.34, mouthFunnel: 0.2 },
  RR: { mouthPucker: 0.2, mouthFunnel: 0.12 },
  kk: { jawOpen: 0.18 },
  DD: { mouthUpperUpLeft: 0.12, mouthUpperUpRight: 0.12 },
  nn: { mouthShrugUpper: 0.15 },
  TH: { mouthLowerDownLeft: 0.12, mouthLowerDownRight: 0.12 },
};

const VISEME_GAIN: Record<string, number> = {
  aa: 1.0,
  E: 0.74,
  I: 0.45,
  O: 0.55,
  U: 0.32,
  // Consonants: small movers on this rig, so they need a higher gain just to
  // register - except PP, which is a closure and has to be unambiguous.
  PP: 1.0,
  FF: 0.45,
  SS: 0.55,
  TH: 0.7,
  DD: 0.62,
  nn: 0.72,
  kk: 1.0,
  CH: 0.5,
  RR: 0.6,
};

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
 * Avatar delivered by the designer, already rigged with its own facial blend
 * shapes - no rig transfer, no donor skeleton, no reweighting. The file in
 * public/ is that delivery passed once through
 * `scripts/avatar-rig-transfer/fix_avatar_morphs.py`, which touches three things
 * and nothing else: the brow mesh now follows the face on every key (it only
 * carried three), `eyesLookUp`/`eyesLookDown` are filled in from the per-eye
 * keys TalkingHead's mood table expects, and the dental assembly sits back far
 * enough to leave a dark cavity in the small apertures. The re-export also
 * stores the morph deltas sparsely - ~11% of the skin's 30k vertices move per
 * key, and the source stored every zero: 79.6 MB -> 23.3 MB, no geometry lost.
 * Audit any GLB with `diag_morphs.py` / `diag_morph_distinct.py` in that folder.
 */
const AVATAR_URL = import.meta.env.VITE_AVATAR_URL ?? "/MANGLARIASK.glb";

/**
 * Physics for the two braids, added by
 * `scripts/avatar-rig-transfer/add_hair_bones.py`.
 *
 * The designer rig skins the braids rigidly to `Head`, so they were welded to
 * the skull: she could turn and nod and the hair moved as one solid piece,
 * which is most of what made her read as plastic. Each braid now carries a
 * three-bone chain and TalkingHead's DynamicBones swings it.
 *
 * Why the chains have three bones and only the last two appear here: "link"
 * updates the *parent's* quaternions, so an entry for `HairL1` would rotate
 * `Head` itself and bob the whole skull. Entries on bones 2 and 3 articulate
 * bones 1 and 2 and leave the head alone.
 *
 * `pivot: true` on the upper joint is the gravity: it compensates the parent's
 * X/Z rotation so the braid hangs down the world Y-axis instead of being
 * carried rigidly by the head - tilt her head and the braid stays vertical,
 * then catches up. Stiffness/damping are in the range the library's own
 * ponytail example uses, scaled up because these braids are 9 cm and light
 * rather than long and heavy. The `limits` on the lower joint cap the swing so
 * a fast head turn cannot throw a braid through her cheek.
 */
const HAIR_DYNAMIC_BONES: DynamicBoneConfig[] = ["L", "R"].flatMap((side) => [
  {
    bone: `Hair${side}2`,
    type: "link",
    stiffness: 260,
    damping: 11,
    external: 0.85,
    pivot: true,
  },
  {
    bone: `Hair${side}3`,
    type: "link",
    stiffness: 380,
    damping: 12,
    limits: [[-0.03, 0.03], null, [-0.03, 0.03], null],
  },
]);

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
 * Torso "body language" beats, interleaved with the arm gestures in
 * `startBodyLanguage`.
 *
 * These used to be the ONLY body language, because on the retired Tripo avatar
 * the arm geometry was welded to the shoulder bone and any arm gesture inflated
 * the skirt into a ~30 cm wing. That does not apply to the designer's rig:
 * re-measured in-engine, the dress is 0.771 m wide at rest, 0.775 m under
 * `handup` and 0.773 m under a talking-hands beat - a 4 mm difference. So the
 * arms are free now, and these remain as punctuation between hand gestures.
 *
 * Values are absolute local Euler rotations (rad), kept small for a warm,
 * professional read. Rotating only Spine1/Spine2/Neck/Head deforms cleanly.
 */
type BoneEuler = { x: number; y: number; z: number };
const BODY_GESTURES: Record<string, Record<string, BoneEuler>> = {
  // Engaged lean toward the user - the workhorse "I'm presenting to you" beat.
  leanIn: {
    "Spine1.rotation": { x: 0.09, y: 0.0, z: 0.0 },
    "Spine2.rotation": { x: 0.05, y: 0.03, z: 0.0 },
    "Neck.rotation": { x: -0.05, y: 0.05, z: 0.0 },
    "Head.rotation": { x: -0.03, y: 0.07, z: 0.0 },
  },
  // Gentle affirmation nod.
  nod: {
    "Neck.rotation": { x: 0.1, y: 0.0, z: 0.0 },
    "Head.rotation": { x: 0.12, y: 0.0, z: 0.0 },
  },
  // Curious head tilt - warmth while making a point.
  tiltCurious: {
    "Neck.rotation": { x: 0.0, y: 0.03, z: 0.1 },
    "Head.rotation": { x: -0.02, y: 0.08, z: 0.09 },
  },
  // Subtle upper-body weight shift for liveliness between the stronger beats.
  sway: {
    "Spine1.rotation": { x: 0.02, y: 0.06, z: -0.05 },
    "Neck.rotation": { x: 0.0, y: -0.04, z: 0.03 },
    "Head.rotation": { x: 0.0, y: -0.03, z: 0.04 },
  },
};
/** Weighted toward the gentle lean/nod; one is played every few seconds while speaking. */
const BODY_GESTURE_POOL = ["leanIn", "nod", "leanIn", "tiltCurious", "nod", "sway"];

/**
 * How far the eyeballs turn, in radians, per unit of TalkingHead's gaze value.
 *
 * TalkingHead does not rotate eye bones. It converts its internal `eyesRotateX`
 * / `eyesRotateY` into the ARKit *morphs* `eyeLook{In,Out}{Left,Right}` and
 * `eyesLook{Up,Down}`, which on a Ready Player Me avatar deform the eyeball mesh
 * itself. On this rig those morphs live on the SKIN - they move the lids and the
 * flesh around the socket - while the eyeballs are separate meshes carrying no
 * morph targets at all, weighted 100% to `LeftEye`/`RightEye`. So the lids
 * tracked the gaze and the irises never moved. We read the gaze back out of the
 * morphs and turn the bones ourselves.
 *
 * Its gaze values run [-0.6, 0.6] horizontally and [-0.2, 0.6] vertically, so
 * these give a ~21 degree maximum saccade sideways: a conversational glance,
 * not a cartoon eye-roll.
 */
const EYE_YAW_RAD = 0.6;
const EYE_PITCH_RAD = 0.5;

/**
 * Idle gaze wander, layered on top of whatever TalkingHead decides.
 *
 * Measured over 25-second windows, the library moves the eyes horizontally on
 * roughly 7% of frames - its saccades fire on a 2-10 second timer, so between
 * them the gaze is perfectly still, which reads as a doll. Its vertical range is
 * also deliberately asymmetric (`eyesRotateX: [[-0.2, 0.6]]`, three times
 * further down than up), so she almost never looks up.
 *
 * This adds a slow continuous drift in both axes to fill the gaps. Amplitudes
 * are small on purpose: enough that the eyes are never frozen, not so much that
 * she looks shifty. The two frequencies per axis are incommensurate, so the
 * pattern does not visibly repeat, and it needs no random source in the render
 * loop.
 */
const EYE_WANDER_YAW_RAD = 0.07; // ~4 degrees
const EYE_WANDER_PITCH_RAD = 0.045; // ~2.6 degrees
/** Ceiling on the combined gaze, so the wander can never push the iris into the corner. */
const EYE_MAX_YAW_RAD = 0.42;
const EYE_MAX_PITCH_RAD = 0.32;
/**
 * Cancels TalkingHead's constant downward gaze bias.
 *
 * Its camera look-at computes `eyesRotateX: [-3 * drotx + 0.1]` - the `0.1` is a
 * hardcoded stylistic offset for its reference avatar, not part of the look-at
 * maths. Combined with the asymmetric saccade range it puts a hard floor under
 * the vertical gaze: measured over 34 seconds the pitch never once went above
 * level, so she could look down, left and right but never up. 0.1 gaze units
 * times EYE_PITCH_RAD is exactly this much.
 */
const EYE_PITCH_TRIM = 0.05;

/** Vendored HeadAudio (audio-driven viseme detection). Served from public/. */
const HEADAUDIO_BASE = "/headaudio";

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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
  /** Self-rescheduling timer that plays rig-safe body-language while speaking. */
  private bodyLangTimer: ReturnType<typeof setTimeout> | null = null;
  /** Alternate the mirror flag so beats don't always lean the same way. */
  private bodyLangMirror = false;



  /** Eye bones plus their bind rotation, so gaze is applied as a delta. */
  private eyeBones: { bone: Bone; rest: Quaternion }[] = [];
  private readonly eyeEuler = new Euler();
  private readonly eyeDelta = new Quaternion();
  /** Seconds since load, driving the idle gaze wander. */
  private eyeClock = 0;

  // Expressive Facial Gestures & Blend Shapes
  private currentState: AvatarState = "idle";
  private currentFacialMorphs: Record<string, number> = {};
  private speechEmphasisTimer = 0;
  private speechEmphasisValue = 0;

  // The mouth is pure geometry now. The designer rig carries real viseme blend
  // shapes over a modelled cavity (teeth, gums, tongue), so the canvas sprite
  // that used to fake an opening on the old sealed mesh is gone - see
  // scripts/avatar-rig-transfer/diag_morphs.py for the per-target audit.

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
      // --- Lighting: the default rig (direct=30, ambient=2, RoomEnvironment)
      // reads far too brilliant on the dark Manglara skin, so we dial it down
      // here instead of hacking the TalkingHead bundle.
      lightAmbientColor: 0xfff1e0,
      lightAmbientIntensity: 0.9,
      lightDirectColor: 0xffffff,
      lightDirectIntensity: 12,
      lightSpotColor: 0x3388ff,
      lightSpotIntensity: 0,
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
        modelDynamicBones: HAIR_DYNAMIC_BONES,
      });
      if (this.disposed) return; // disposed mid-load → dispose() handles teardown
      // Framing: wide enough to include the hands.
      //
      // This was 1.5 / 0.5, which cropped just below the collarbone. That was
      // fine when the body language was torso-only, but the talking-hands
      // gestures put the forearms around chest and belly height, and at that
      // distance they played entirely off-screen. Pulled back to where the
      // frame reaches the waist: the gestures land in shot and the face is
      // still large enough to read the mouth and the gaze.
      head.setView("upper", { cameraDistance: 2.6, cameraY: 0.75 });
      this.registerBodyLanguage(head);
      this.setupTeethAndTongue(head);
      this.captureEyeBones(head);
      // Single per-frame hook, wired before any streaming starts so the mouth
      // works regardless of whether HeadAudio (the fallback) ever loads.
      // TalkingHead calls this right before it applies morph targets.
      head.opt.update = (dt: number) => {
        this.updateVisemes(dt);
        // HeadAudio always ticks (it tracks the audio continuously), but its
        // morph writes are gated on `textInCharge` inside its onvalue hook -
        // both write the same `newvalue` slot, so only one may win per frame.
        // Running after us means it takes over cleanly when text runs dry.
        this.headAudio?.update(dt);
        this.updateFacialExpressions(dt);
        // Last: it reads the gaze morphs the two calls above may have written,
        // and TalkingHead applies bone matrices after `opt.update` returns.
        this.updateEyeGaze(dt);
      };
      head.start();
      // Tame the remaining brilliance: the RoomEnvironment map adds bright
      // specular reflections on the skin, and ACES tone mapping defaults to
      // full exposure. Soften both so the dark skin reads correctly.
      // `scene`/`renderer` are runtime props on the TalkingHead instance but
      // not surfaced by its typings, hence the structural cast.
      const th = head as unknown as {
        scene?: { environmentIntensity?: number };
        renderer?: { toneMappingExposure: number };
      };
      if (th.scene) {
        // three r0.155+ supports a global environment intensity multiplier.
        th.scene.environmentIntensity = 0.45;
      }
      if (th.renderer) {
        th.renderer.toneMappingExposure = 0.9;
      }
      this._ready = true;
      // Expose for manual debugging in the console.
      const dbg = window as unknown as Record<string, unknown>;
      dbg.__head = head;
      dbg.__sayTest = (text: string) => this.testLipsync(text);
      // Audio-free lip-sync testing surface. See scripts/lipsync-console-test.js.
      dbg.__say = (text: string) => this.say(text);
      dbg.__phonemes = (text: string) => this.phonemesOf(text);
      dbg.__visemes = AvatarController.VISEMES;
      dbg.__mood = (mood: string) => {
        this.setMood(mood);
        console.log("[mood]", mood);
      };
      dbg.__body = (name: string) => {
        this.playBodyGesture(name);
        console.log("[body]", name);
      };
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
  private freqData: Uint8Array | null = null;
  private timeData: Uint8Array | null = null;

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

  /**
   * Set one named morph, on every mesh that carries it.
   *
   * `newvalue` alone would do, but TalkingHead eases it over its own frames.
   * Writing the influence arrays too lands the value on the frame it was
   * chosen on. The designer rig splits the head across skin/brow/teeth
   * primitives, so `mt.ms` routinely holds three arrays for one viseme.
   */
  /**
   * Turn the eyeballs to match the gaze TalkingHead has already decided.
   *
   * Runs every frame off the morph values rather than off our own logic, so the
   * eyes inherit everything the library does for free: eye contact with the
   * camera, idle saccades, the per-mood gaze offsets, and the look-away while
   * thinking. See EYE_YAW_RAD for why the bones need driving at all.
   *
   * Axis convention was measured on this rig, not assumed - after the `Hips`
   * lesson. The eye bones sit in a near-identity frame relative to the head:
   * local +X maps to world (0.992, 0.022, 0.122), +Y to (-0.049, 0.975, 0.217)
   * and +Z to (-0.115, -0.221, 0.968), and the bone-to-iris direction is
   * (0.043, 0.052, 0.998). So local Z is the line of sight, Y is yaw and X is
   * pitch, with positive rotations matching TalkingHead's own sign convention
   * (`eyesRotateY > 0` looks to her left; `eyesRotateX > 0` looks down).
   */
  private updateEyeGaze(dt: number): void {
    const head = this.head;
    const eyes = this.eyeBones;
    if (!head || !eyes.length) return;
    this.eyeClock += dt / 1000;

    const read = (k: string): number => {
      const mt = head.mtAvatar[k];
      if (!mt || !Array.isArray(mt.ms) || !Array.isArray(mt.is)) return 0;
      const arr = mt.ms[0];
      const idx = mt.is[0];
      if (!arr || idx === undefined) return 0;
      return arr[idx] ?? 0;
    };

    // Reconstruct the signed gaze from the split morph pairs TalkingHead
    // decomposed it into. Both eyes share one direction: the library's mapping
    // pairs "out" on one eye with "in" on the other, so they track together.
    let yaw = (read("eyeLookOutLeft") - read("eyeLookInLeft")) * EYE_YAW_RAD;
    let pitch =
      (read("eyesLookDown") - read("eyesLookUp")) * EYE_PITCH_RAD - EYE_PITCH_TRIM;

    const t = this.eyeClock;
    yaw += EYE_WANDER_YAW_RAD * (Math.sin(t * 0.37) * 0.6 + Math.sin(t * 0.83) * 0.4);
    pitch += EYE_WANDER_PITCH_RAD * (Math.sin(t * 0.29) * 0.6 + Math.sin(t * 0.61) * 0.4);
    yaw = Math.max(-EYE_MAX_YAW_RAD, Math.min(EYE_MAX_YAW_RAD, yaw));
    pitch = Math.max(-EYE_MAX_PITCH_RAD, Math.min(EYE_MAX_PITCH_RAD, pitch));

    this.eyeEuler.set(pitch, yaw, 0, "YXZ");
    this.eyeDelta.setFromEuler(this.eyeEuler);
    for (const { bone, rest } of eyes) {
      bone.quaternion.copy(rest).multiply(this.eyeDelta);
    }
  }

  private applyMorph(head: TalkingHead, k: string, val: number): void {
    const mt = head.mtAvatar[k];
    if (!mt) return;
    mt.newvalue = val;
    mt.needsUpdate = true;
    const { ms, is } = mt;
    if (!Array.isArray(ms) || !Array.isArray(is)) return;
    for (let i = 0; i < ms.length; i++) {
      const arr = ms[i];
      const idx = is[i];
      if (arr && idx !== undefined) arr[idx] = val;
    }
  }

  /**
   * Push a shape into the morph targets, releasing whatever was held before.
   *
   * `intensity` is the driver's loudness relative to the speaker's own recent
   * peak (1 = as loud as she gets). It scales the whole thing, so an emphasised
   * word opens further than a trailing-off one instead of every syllable being
   * written at the same maximum.
   */
  private writeVisemeMorphs(shape: string | null, intensity = 1): void {
    const head = this.head;
    if (!head) return;

    const morphsToWrite: Record<string, number> = {};
    const applyMorph = (k: string, val: number) => this.applyMorph(head, k, val);

    if (shape && shape !== "sil") {
      const gain = VISEME_GAIN[shape] ?? 0.7;
      // A closure is a closure at any volume - a quietly-spoken /p/ still has
      // the lips fully together - so PP opts out of the loudness scaling.
      const level =
        shape === "PP"
          ? VISEME_LEVEL
          : VISEME_LEVEL_MIN + (VISEME_LEVEL - VISEME_LEVEL_MIN) * clamp01(intensity);
      morphsToWrite[`viseme_${shape}`] = level * gain;
      // Articulation chord on top of the viseme. Scaled by the same level, so
      // a murmured /o/ purses the lips slightly and a shouted one properly.
      for (const [k, w] of Object.entries(VISEME_EXTRAS[shape] ?? {})) {
        morphsToWrite[k] = level * w;
      }
    }

    for (const [k, v] of Object.entries(morphsToWrite)) {
      applyMorph(k, v);
    }

    for (const prev of this.writtenVisemes) {
      if (!(prev in morphsToWrite)) {
        applyMorph(prev, 0);
      }
    }
    this.writtenVisemes.clear();
    for (const k of Object.keys(morphsToWrite)) {
      this.writtenVisemes.add(k);
    }
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
    // MEASURE FIRST. `streamAudio` posts the ArrayBuffer to the worklet with a
    // transfer list (talkinghead.mjs: `postMessage(message, [message.data])`),
    // which DETACHES it - `pcm.byteLength` is 0 afterwards. Reading it after the
    // call meant `audioFedMs` never left 0, so `buffered` was always 0 and the
    // driver ran permanently at MAX_RATE (1.9x). That, not the pacing formula,
    // is why the live mouth was rushed and out of step.
    // 16-bit mono at 24 kHz → 48 bytes per ms.
    const chunkMs = pcm.byteLength / 2 / (GEMINI_SAMPLE_RATE / 1000);
    this.head.streamAudio({ audio: pcm });
    this.audioFedMs += chunkMs;
    this.record("au");
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
      const dryShape = this.driver.tick({
        dt,
        speaking: true,
        // No real audio: let the playback clock run free at natural pace.
        audioFedMs: Number.MAX_SAFE_INTEGER,
        naturalPace: true,
      });
      this.writeVisemeMorphs(dryShape, this.driver.intensity);

      return;
    }

    // `isSpeaking` only gates whether the mouth may move at all. It is set the
    // instant a chunk is POSTED to the worklet, well before a sample is rendered,
    // so it must never be the timing source - the measured clock below stays at 0
    // until audio is genuinely consumed, which is what stops the mouth starting
    // ahead of the voice.
    const speaking = head.isSpeaking === true;
    let shape: string | null = null;

    if (speaking && this.analyserNode && this.freqData && this.timeData) {
      this.analyserNode.getByteFrequencyData(this.freqData);
      this.analyserNode.getByteTimeDomainData(this.timeData);
      shape = this.driver.tickFrame({
        dt,
        frequencyData: this.freqData,
        timeDomainData: this.timeData,
      });
    } else {
      shape = this.driver.tick({
        dt,
        speaking,
        audioFedMs: this.audioFedMs,
        playedMs: this.measurePlayback(),
      });
    }

    this.textInCharge = true;
    this.writeVisemeMorphs(shape, this.driver.intensity);


    if (this.diagnose) {
      this.diagLastLog += dt;
      if (this.diagLastLog >= 250) {
        this.diagLastLog = 0;
        console.log(
          `[lipsync] ${speaking ? "AUDIO" : "silencio"} ` +
            `fuente=audio-analyser ` +
            `forma=${shape ?? "-"} ` +
            `oido=${Math.round(this.playedMs)}ms ` +
            `entregado=${Math.round(this.audioFedMs)}ms`
        );
      }
    }
  }

  /** Drop all pending mouth shapes and reset the lip-sync clock. */
  private resetVisemeState(why: string): void {
    this.resetCounts[why] = (this.resetCounts[why] ?? 0) + 1;
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
    const totalMs = unitsDuration(units);
    return new Promise((resolve) => {
      const started = performance.now();
      const check = (): void => {
        // Wait for the queue to drain, with a ceiling in case rendering stalls
        // (the avatar's animation loop only runs while the tab is visible).
        if (!this.dryRun || performance.now() - started > totalMs + 2000) {
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
    this.head?.streamInterrupt(); // stops playback and purges queued visemes
    this.resetVisemeState("interrupted");
    this.writeVisemeMorphs(null); // release the shape being held
  }

  /** Leave streaming mode (keeps the avatar mounted and idle). */
  stopStream(): void {
    if (!this.streaming) return;
    this.head?.streamStop();
    this.streaming = false;
    this.resetVisemeState("stopStream");
    this.textVisemesActive = false;
  }

  /** Map the call state machine to gaze + facial mood. */
  setState(state: AvatarState): void {
    const head = this.head;
    if (!head || !this._ready || state === this.lastState) return;
    this.lastState = state;
    this.currentState = state;
    if (state === "thinking") {
      // Pondering: glance away and let the face settle to a calmer, neutral read
      // so the "thinking" beat is legible against the warm speaking face.
      this.setMood(THINKING_MOOD);
      head.lookAhead(2000);
      this.stopBodyLanguage();
    } else if (state === "speaking") {
      // Warm and animated while presenting: eye contact plus the "happy" mood's
      // speaking animation (brows, head-sway, micro-mouth) PLUS rig-safe torso/
      // head body language (lean-in, nods, tilts) - lively presenting without
      // touching the arm rig that would balloon the dress.
      this.setMood(DEFAULT_MOOD);
      head.makeEyeContact(3000);
      this.startBodyLanguage();
    } else {
      // idle / listening: attentive, smiling, looking at the user, with a single
      // gentle lean-in so she reads as actively listening.
      this.setMood(DEFAULT_MOOD);
      head.lookAtCamera(500);
      this.stopBodyLanguage();
      this.playBodyGesture("leanIn");
    }
  }

  /**
   * Register the rig-safe body-language poses (see BODY_GESTURES) into
   * TalkingHead's gestureTemplates so `playGesture` can drive them. Touches only
   * torso/neck/head bones, so it never balloons the arm-welded dress.
   */
  private registerBodyLanguage(head: TalkingHead): void {
    if (!head.gestureTemplates) return;
    for (const [name, tmpl] of Object.entries(BODY_GESTURES)) {
      head.gestureTemplates[name] = tmpl as Record<string, unknown>;
    }
  }

  /** Play one body-language beat; holds briefly then eases back to idle. */
  private playBodyGesture(name: string): void {
    const head = this.head;
    if (!head) return;
    try {
      head.playGesture(name, 2.5, this.bodyLangMirror, 700);
    } catch {
      // Unknown template / build mismatch: skip rather than break the call.
    }
    this.bodyLangMirror = !this.bodyLangMirror;
  }

  /**
   * One beat of talking hands: TalkingHead IK-solves both arms to a random
   * nearby target and eases them there and back.
   *
   * The library calls this itself, but exactly once per `playback-started`, so
   * a long answer got a single gesture in its first second and then went still.
   * Driving it on the same cadence as the torso beats keeps the hands alive for
   * the whole turn.
   *
   * `speakWithHands` bails out if a gesture is already playing (`this.gesture`),
   * which is why hands and torso share one scheduler instead of running two
   * timers that would silently starve each other.
   */
  private playTalkingHands(): void {
    const head = this.head;
    if (!head) return;
    try {
      head.stopGesture(400); // clear any held torso pose, or this is a no-op
      head.speakWithHands(0, 1);
    } catch {
      // Older build without the IK path: fall back to a torso beat.
    }
  }

  /**
   * Start the speaking-time body-language loop (idempotent).
   *
   * Alternates arms and torso. Roughly two hand beats per torso beat: the hands
   * carry most of conversational body language, and the torso leans read as
   * punctuation between them.
   */
  private startBodyLanguage(): void {
    if (this.bodyLangTimer || !this.head) return;
    let beat = 0;
    const tick = () => {
      if (beat % 3 === 2) {
        const name =
          BODY_GESTURE_POOL[Math.floor(Math.random() * BODY_GESTURE_POOL.length)];
        this.playBodyGesture(name);
      } else {
        this.playTalkingHands();
      }
      beat++;
      this.bodyLangTimer = setTimeout(tick, 2600 + Math.random() * 2200);
    };
    // First beat shortly after she starts speaking.
    this.bodyLangTimer = setTimeout(tick, 600);
  }

  /** Stop the loop and relax any held pose back to idle. */
  private stopBodyLanguage(): void {
    if (this.bodyLangTimer) {
      clearTimeout(this.bodyLangTimer);
      this.bodyLangTimer = null;
    }
    try {
      this.head?.stopGesture(600);
    } catch {
      // ignore
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

  dispose(): void {
    this.disposed = true;
    this.stopBodyLanguage();
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

    this.eyeBones = [];
    this.headAudio = null;
    this.headAudioReady = false;
    this.head = null;
    this._ready = false;
  }

  /** Grab the eye bones and their bind rotation once, for updateEyeGaze(). */
  private captureEyeBones(head: TalkingHead): void {
    this.eyeBones = [];
    const root = (head as unknown as { armature?: Object3D }).armature;
    root?.traverse((o) => {
      const b = o as Bone;
      if (b.isBone && (b.name === "LeftEye" || b.name === "RightEye")) {
        this.eyeBones.push({ bone: b, rest: b.quaternion.clone() });
      }
    });
    if (this.eyeBones.length !== 2) {
      console.warn(
        `[avatar] expected 2 eye bones, found ${this.eyeBones.length} — gaze will not move`
      );
    }
  }

  /** Realce de material de dientes y limpieza de vertex colors. */
  private setupTeethAndTongue(head: TalkingHead): void {
    try {
      const root = (head as unknown as { armature?: Object3D }).armature;
      if (!root) return;

      // 1. Limpieza de vertex colors para asegurar texturas puras sin sombras negras
      root.traverse((o) => {
        if ((o as Mesh).isMesh) {
          const mesh = o as Mesh;
          if (mesh.geometry) {
            mesh.geometry.deleteAttribute("color");
            mesh.geometry.deleteAttribute("Color");
            mesh.geometry.deleteAttribute("COLOR_0");
          }
          if (mesh.material) {
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const mat of mats) {
              if (mat && "vertexColors" in mat) {
                (mat as MeshStandardMaterial).vertexColors = false;
                mat.needsUpdate = true;
              }
            }
          }
          const name = mesh.name.toLowerCase();
          const matName = (mesh.material as any)?.name ?? "";
          if (
            name.includes("diente") ||
            name.includes("teeth") ||
            matName === "Material.002"
          ) {
            const mat = mesh.material as MeshStandardMaterial;
            if (mat) {
              mat.color = new Color(0xffffff);
              mat.roughness = 0.12;
              mat.metalness = 0.0;
              // One material covers enamel, gums, tongue AND the cavity behind
              // them, so emissive lifts the whole inside of the mouth. The old
              // 0x383838 was there to make a flat painted patch readable; with
              // real geometry it just washed the cavity out and every viseme
              // read as "two rows of teeth". Keep a token amount so the teeth
              // don't go muddy in the small apertures (/o/, /u/).
              mat.emissive = new Color(0x101010);
              mat.needsUpdate = true;
            }
          }
        }
      });

      console.log("[avatar] Dientes realzados y vertex colors limpiados.");
    } catch (err) {
      console.warn("[avatar] setupTeethAndTongue error:", err);
    }
  }



  /** Actualizar gestos faciales, cejas, ojos y sonrisa según el estado conversacional. */
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
      mouthSmile: 0,
    };

    if (this.currentState === "speaking") {
      // Sonrisa comunicativa viva mientras habla
      targets.mouthSmile = 0.32;
      targets.eyeSquintLeft = 0.2;
      targets.eyeSquintRight = 0.2;
      targets.cheekSquintLeft = 0.18;
      targets.cheekSquintRight = 0.18;

      // Énfasis dinámico de cejas al ritmo del habla
      this.speechEmphasisTimer += dt;
      if (this.speechEmphasisTimer > 2200) {
        this.speechEmphasisTimer = 0;
        this.speechEmphasisValue =
          Math.random() > 0.3 ? 0.5 + Math.random() * 0.35 : 0;
      }
      // Decaer el énfasis suavemente
      const decay = Math.min(1, dt / 600);
      this.speechEmphasisValue *= 1 - decay;

      targets.browInnerUp = 0.25 + this.speechEmphasisValue;
      targets.browOuterUpLeft = 0.15 + this.speechEmphasisValue * 0.7;
      targets.browOuterUpRight = 0.15 + this.speechEmphasisValue * 0.7;
    } else if (this.currentState === "thinking") {
      // Expresión reflexiva / pensando
      targets.browInnerUp = 0.48;
      targets.browDownLeft = 0.38;
      targets.browDownRight = 0.2;
      targets.eyeSquintLeft = 0.15;
      targets.mouthSmile = 0.05;
    } else {
      // idle / listening: atenta, acogedora y receptiva
      targets.mouthSmile = 0.28;
      targets.eyeWideLeft = 0.16;
      targets.eyeWideRight = 0.16;
      targets.browInnerUp = 0.22;
    }

    // Aplicar interpolación suave a cada blend shape facial
    const lerpSpeed = Math.min(1, dt / 120);
    for (const [k, targetVal] of Object.entries(targets)) {
      const cur = this.currentFacialMorphs[k] ?? 0;
      const next = cur + (targetVal - cur) * lerpSpeed;
      this.currentFacialMorphs[k] = next;
      this.applyMorph(head, k, next);
    }
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
