/**
 * What the body does while she talks, and *when*.
 *
 * The version this replaces fired one gesture every 3.5-6 seconds off a
 * `setTimeout`, with no connection to what was being said. That is what makes a
 * talking head read as a puppet even when the mouth is perfect: real speakers do
 * not gesture on a timer, they gesture on the *structure* of what they are
 * saying. A hand beat lands at a clause boundary; a head accent and a brow lift
 * land on a stressed syllable.
 *
 * The lip-sync track already knows both - `viseme-driver` emits a beat when the
 * playback cursor crosses a stressed syllable or a pause - so the body runs off
 * the same clock as the mouth, which is what makes them look like one
 * performance instead of two animations sharing a screen.
 *
 * ONE beat moves the whole body. Alternating channels - TalkingHead's
 * `speakWithHands` IK, its arm pose templates and our torso templates - makes
 * them fight each other: `playGesture` truncates a running `speakWithHands`
 * animation by zeroing its keyframe times, which runs its whole timeline in a
 * single frame, and a torso beat following an arm beat leaves the arms stranded
 * mid-pose (see `avatar-controller.playGestureBeat`). Every beat here names an
 * arm pose *and* a torso pose and is played as one gesture, so nothing is ever
 * half-applied.
 *
 * Pure: it decides, the controller executes. No timers, no three.js.
 */

import type { Beat } from "./viseme-driver";

export type MotionAction =
  /**
   * One whole-body beat: an arm pose (or none, for a small torso-only beat)
   * plus a torso pose, played together as a single gesture.
   */
  | {
      kind: "gesture";
      /** A TalkingHead arm template, or null to let the arms settle back. */
      arm: string | null;
      /** One of BODY_GESTURES. Always present: every beat moves the torso. */
      torso: string;
      mirror: boolean;
      /** How long to hold it before relaxing, ms. */
      holdMs: number;
      /** How long to travel into it, ms. */
      easeMs: number;
    }
  /** A fast head-and-brow accent on a stressed syllable. */
  | {
      kind: "accent";
      /** Overall size, 0..1. */
      strength: number;
      /** Chin dip, in radians. Positive is down. */
      nod: number;
      /** Head roll, in radians. */
      tilt: number;
      /** Head turn, in radians. */
      turn: number;
    }
  /** A blink. Speakers blink at phrase boundaries, and it reads as punctuation. */
  | { kind: "blink" }
  /** Release whatever pose is held and return to idle. */
  | { kind: "relax" };

/**
 * Torso beats, as absolute local Euler rotations in radians.
 *
 * Rotating only Spine1/Spine2/Neck/Head deforms cleanly on this rig. Values are
 * kept small for a warm, professional read - these are punctuation between the
 * arm gestures, not the performance itself.
 *
 * Every entry names all four joints, even where the value is a plain zero. A
 * gesture that omits a joint the previous gesture moved does not return it, it
 * merely stops restoring it (see `avatar-controller.playGestureBeat`), and the
 * spine stays creased from a lean two beats ago.
 */
export const BODY_GESTURES: Record<string, Record<string, { x: number; y: number; z: number }>> = {
  // Engaged lean toward the user - the workhorse "I'm presenting to you" beat.
  leanIn: {
    "Spine1.rotation": { x: 0.09, y: 0, z: 0 },
    "Spine2.rotation": { x: 0.05, y: 0.03, z: 0 },
    "Neck.rotation": { x: -0.05, y: 0.05, z: 0 },
    "Head.rotation": { x: -0.03, y: 0.07, z: 0 },
  },
  // Gentle affirmation nod.
  nod: {
    "Spine1.rotation": { x: 0.03, y: 0, z: 0 },
    "Spine2.rotation": { x: 0.02, y: 0, z: 0 },
    "Neck.rotation": { x: 0.1, y: 0, z: 0 },
    "Head.rotation": { x: 0.12, y: 0, z: 0 },
  },
  // Curious head tilt - warmth while making a point.
  tiltCurious: {
    "Spine1.rotation": { x: 0.02, y: 0, z: 0.02 },
    "Spine2.rotation": { x: 0.02, y: 0, z: 0.02 },
    "Neck.rotation": { x: 0, y: 0.03, z: 0.1 },
    "Head.rotation": { x: -0.02, y: 0.08, z: 0.09 },
  },
  // Subtle upper-body weight shift for liveliness between the stronger beats.
  sway: {
    "Spine1.rotation": { x: 0.02, y: 0.06, z: -0.05 },
    "Spine2.rotation": { x: 0.01, y: 0.04, z: -0.03 },
    "Neck.rotation": { x: 0, y: -0.04, z: 0.03 },
    "Head.rotation": { x: 0, y: -0.03, z: 0.04 },
  },
  // Settling back after making a point - the counterweight to leanIn, without
  // which a run of beats all pushes the same way and she creeps toward camera.
  settleBack: {
    "Spine1.rotation": { x: -0.05, y: -0.03, z: 0 },
    "Spine2.rotation": { x: -0.03, y: -0.02, z: 0 },
    "Neck.rotation": { x: 0.04, y: -0.03, z: 0 },
    "Head.rotation": { x: 0.03, y: -0.05, z: -0.02 },
  },
  // Sharper forward accent for a strong point. Bigger than leanIn on purpose.
  emphasise: {
    "Spine1.rotation": { x: 0.13, y: 0, z: 0 },
    "Spine2.rotation": { x: 0.07, y: 0, z: 0 },
    "Neck.rotation": { x: 0.06, y: 0, z: 0 },
    "Head.rotation": { x: 0.09, y: 0, z: 0.03 },
  },
  // Open-chest invitation for explaining an idea or welcoming a response.
  openChest: {
    "Spine1.rotation": { x: 0.04, y: 0, z: 0 },
    "Spine2.rotation": { x: -0.02, y: 0, z: 0 },
    "Neck.rotation": { x: -0.03, y: 0, z: 0 },
    "Head.rotation": { x: -0.04, y: 0, z: 0 },
  },
  // Asymmetric weight shift keeps a sequence of gestures from looking mirrored.
  weightShift: {
    "Spine1.rotation": { x: 0.01, y: -0.04, z: 0.08 },
    "Spine2.rotation": { x: 0.01, y: -0.03, z: 0.05 },
    "Neck.rotation": { x: 0, y: 0.04, z: -0.04 },
    "Head.rotation": { x: 0, y: 0.06, z: -0.06 },
  },
};

/**
 * Arm poses. These are TalkingHead's OWN templates, already authored on the
 * left arm down to the finger joints, and `playGesture(..., mirror)` flips them
 * to the right - so they cost nothing to use and look far more deliberate than
 * `speakWithHands`, whose IK targets are random points in space.
 *
 * The pool is weighted rather than uniform. `side` is the open-palm presenting
 * gesture and fits a presenter talking about her subject, so it appears most;
 * `shrug`, `ok` and `thumbup` stay occasional so they add personality without
 * turning every sentence into a sign. They stay reachable from `window.__body`.
 */
export const ARM_GESTURES = [
  "side", "side",
  "handup", "handup",
  "index", "index",
  "shrug",
  "ok",
  "thumbup",
];

/** Weighted toward the gentle lean and nod; the rest is punctuation. */
const TORSO_POOL = [
  "leanIn", "leanIn",
  "nod", "nod",
  "emphasise",
  "tiltCurious",
  "settleBack",
  "sway",
  "openChest",
  "weightShift",
];

type GestureCue = "present" | "emphasise" | "settle";

/** Gesture vocabulary follows speech intent instead of being rolled at random. */
const PRESENTING_ARMS = ["side", "handup", "shrug"] as const;
const EMPHASIS_ARMS = ["index", "ok", "thumbup"] as const;

/**
 * How long a beat is given to travel into place.
 *
 * This is the number handed to TalkingHead, and it is NOT how long the movement
 * takes on screen. `updatePoseBase` slerps `poseBase` toward the target IN PLACE
 * by `easing(elapsed / d)` every frame, so the remaining distance is cut by a
 * growing fraction on every frame and about 90% of the travel is spent by
 * `0.4 * d`. A 220 ms ease therefore plays as a ~90 ms snap - that is the jump
 * arms make, and no amount of retiming the *scheduler* can fix it, because the
 * pop is inside a single transition.
 *
 * 1100 ms reads as a ~440 ms stroke, which gives an arm time to travel instead
 * of snapping into the next pose.
 */
const ARM_EASE_MS = 1100;
const TORSO_EASE_MS = 900;
/**
 * How long a pose is held before relaxing. TalkingHead releases it over the same
 * `easeMs`, so a beat occupies roughly `easeMs + holdMs + easeMs`.
 */
const ARM_HOLD_MS = 2200;
const TORSO_HOLD_MS = 1800;

/**
 * Minimum spacing between beats, measured from the start of the previous one.
 * A flat spacing shorter than an arm gesture takes to arrive, hold and leave
 * means every beat is cut off by the next one and the arms never settle.
 */
const ARM_REFRACTORY_MS = 4500;
const TORSO_REFRACTORY_MS = 3700;
/**
 * Once this long has passed since the last beat, a stressed syllable is allowed
 * to start one too.
 *
 * leaves whole sentences still. Stresses are where a speaker's beat gestures
 * actually land, so filling the gap from one keeps the body on the prosody
 * rather than on a timer - which is the entire point of running off the lip-sync
 * clock.
 */
const GESTURE_STRESS_GAP_MS = 3800;
/**
 * Longest she may speak without a gesture, whatever the prosody did. A backstop
 * for a stretch with neither a comma nor a stressed syllable in it.
 */
const GESTURE_MAX_GAP_MS = 6500;

/** Minimum spacing between head/brow accents. Faster than this reads as a twitch. */
const ACCENT_REFRACTORY_MS = 850;
/**
 * Share of stressed syllables that get a visible accent. Spanish stresses
 * roughly every other syllable, and accenting all of them is a nervous tic - but
 * much below this whole clauses go by with a completely still head.
 */
const ACCENT_PROBABILITY = 0.35;
/** Chin dip of a full-strength accent, in radians (~5 degrees). */
const ACCENT_NOD_RAD = 0.085;
/** Lateral component, so a run of accents is not the same nod repeated. */
const ACCENT_TILT_RAD = 0.05;
const ACCENT_TURN_RAD = 0.045;

/** Delay before the first beat of a turn, so she does not gesture on the intake. */
const FIRST_BEAT_DELAY_MS = 450;
/** Blinks are punctuation: at most this often, and only at a clause boundary. */
const BLINK_REFRACTORY_MS = 2400;

export interface MotionDirectorOptions {
  /** Injectable for tests; defaults to `Math.random`. */
  random?: () => number;
}

export class MotionDirector {
  private readonly random: () => number;
  private speaking = false;
  private sinceGesture = 0;
  private sinceAccent = 0;
  private sinceBlink = 0;
  private sinceStart = 0;
  /** Spacing the beat now playing demands before the next one may start, ms. */
  private gapMs = 0;
  private beatIndex = 0;
  private mirror = false;
  private lastArm: string | null = null;
  private lastTorso: string | null = null;

  constructor(options: MotionDirectorOptions = {}) {
    this.random = options.random ?? Math.random;
  }

  /** Start of a speaking turn. */
  start(): void {
    if (this.speaking) return;
    this.speaking = true;
    this.sinceStart = 0;
    // The refractory periods exist to space beats out from EACH OTHER, so they
    // must not also delay the first one - the opening delay does that, and it is
    // much shorter.
    this.sinceGesture = 0;
    this.gapMs = 0;
    this.sinceAccent = ACCENT_REFRACTORY_MS;
    this.sinceBlink = BLINK_REFRACTORY_MS;
  }

  /** End of a speaking turn; the caller should play the returned relax. */
  stop(): MotionAction[] {
    if (!this.speaking) return [];
    this.speaking = false;
    return [{ kind: "relax" }];
  }

  /**
   * Advance one frame and return what the body should do.
   *
   * `beats` are the prosodic events the lip-sync clock crossed this frame, so
   * everything here is aligned with the audio the ear is hearing right now - not
   * with when the transcript happened to arrive.
   */
  update(dt: number, beats: Beat[]): MotionAction[] {
    if (!this.speaking) return [];
    this.sinceStart += dt;
    this.sinceGesture += dt;
    this.sinceAccent += dt;
    this.sinceBlink += dt;

    const actions: MotionAction[] = [];
    let wantGesture = false;
    let gestureCue: GestureCue = "settle";
    let wantBlink = false;

    for (const beat of beats) {
      if (beat.kind === "clause") {
        wantGesture = true;
        gestureCue = "present";
        // A longer pause is a bigger boundary, and that is where people blink.
        if (beat.strength > 0.6) wantBlink = true;
        continue;
      }
      // A stress is a weaker cue than a boundary, so it only opens a beat once
      // the body has been still for a while.
      if (this.sinceGesture >= GESTURE_STRESS_GAP_MS) {
        wantGesture = true;
        gestureCue = "emphasise";
      }
      if (this.sinceAccent >= ACCENT_REFRACTORY_MS && this.random() < ACCENT_PROBABILITY) {
        this.sinceAccent = 0;
        const strength = 0.55 + this.random() * 0.45;
        actions.push({
          kind: "accent",
          strength,
          nod: ACCENT_NOD_RAD * strength,
          // Centred on zero so consecutive accents wander instead of drifting.
          tilt: ACCENT_TILT_RAD * (this.random() * 2 - 1),
          turn: ACCENT_TURN_RAD * (this.random() * 2 - 1),
        });
      }
    }

    if (
      wantBlink &&
      this.sinceStart >= FIRST_BEAT_DELAY_MS &&
      this.sinceBlink >= BLINK_REFRACTORY_MS
    ) {
      this.sinceBlink = 0;
      actions.push({ kind: "blink" });
    }

    // A long stretch with no clause boundary still needs punctuation.
    if (this.sinceGesture >= GESTURE_MAX_GAP_MS) {
      wantGesture = true;
      gestureCue = "settle";
    }

    if (wantGesture && this.sinceStart >= FIRST_BEAT_DELAY_MS && this.sinceGesture >= this.gapMs) {
      this.sinceGesture = 0;
      actions.push(this.nextGesture(gestureCue));
    }

    return actions;
  }

  /**
   * The next beat.
   *
  * Ordinary beats alternate arm and torso motion so the arms can settle. A
  * clause may override that rhythm because it is a presentational boundary.
   */
  private nextGesture(cue: GestureCue): MotionAction {
    // A clause is a presentational unit: let the hands carry it even when the
    // alternating body beat would otherwise choose a torso-only filler.
    const withArm = cue === "present" || this.beatIndex % 2 === 0;
    this.beatIndex++;
    // Alternate the mirror flag on ARM beats only. Flipping it every beat looks
    // like alternation but is not: arm poses land on every other beat, so the
    // flag is back where it started by the time one arrives and she gestures
    // with the same arm all turn.
    if (withArm) this.mirror = !this.mirror;
    const torso = this.pick(TORSO_POOL, this.lastTorso);
    this.lastTorso = torso;

    if (!withArm) {
      this.gapMs = TORSO_REFRACTORY_MS;
      return {
        kind: "gesture",
        arm: null,
        torso,
        mirror: this.mirror,
        holdMs: TORSO_HOLD_MS,
        easeMs: TORSO_EASE_MS,
      };
    }

    const armPool = cue === "present" ? PRESENTING_ARMS : EMPHASIS_ARMS;
    const arm = this.pick(armPool, this.lastArm);
    this.lastArm = arm;
    this.gapMs = ARM_REFRACTORY_MS;
    return {
      kind: "gesture",
      arm,
      torso,
      mirror: this.mirror,
      holdMs: ARM_HOLD_MS,
      easeMs: ARM_EASE_MS,
    };
  }

  /**
   * Pick from a weighted pool, never the same entry twice running.
   *
   * The same pose replayed back to back is invisible on screen - she simply
   * holds it for longer - so a repeat wastes a beat. Steps to the next distinct
   * entry rather than re-rolling: `random` is a constant in the tests, and a
   * re-roll loop would never terminate.
   */
  private pick(pool: readonly string[], last: string | null): string {
    const start = Math.floor(this.random() * pool.length) % pool.length;
    for (let n = 0; n < pool.length; n++) {
      const choice = pool[(start + n) % pool.length]!;
      if (choice !== last) return choice;
    }
    return pool[start]!;
  }
}
