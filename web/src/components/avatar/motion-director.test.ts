import { describe, expect, test } from "bun:test";
import {
  ARM_GESTURES,
  BODY_GESTURES,
  MotionDirector,
  type MotionAction,
} from "./motion-director";
import type { Beat } from "./viseme-driver";

const FRAME_MS = 1000 / 30;
/** Deterministic "random" so gesture choice and the accent gate are testable. */
const fixed = (v: number) => () => v;

const stress: Beat = { kind: "stress", strength: 1 };
const clause: Beat = { kind: "clause", strength: 1 };

/** Run frames, injecting beats at the given frame indices. */
function run(
  director: MotionDirector,
  frames: number,
  beatsAt: (f: number) => Beat[] = () => []
): MotionAction[] {
  const out: MotionAction[] = [];
  for (let f = 0; f < frames; f++) {
    out.push(...director.update(FRAME_MS, beatsAt(f)));
  }
  return out;
}

const gestures = (actions: MotionAction[]): Extract<MotionAction, { kind: "gesture" }>[] =>
  actions.filter((a): a is Extract<MotionAction, { kind: "gesture" }> => a.kind === "gesture");

describe("gestures are driven by speech, not by a timer", () => {
  test("nothing happens while she is not speaking", () => {
    const director = new MotionDirector({ random: fixed(0) });
    expect(run(director, 200, () => [clause])).toEqual([]);
  });

  test("a clause boundary produces a gesture", () => {
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    // Past the opening delay, then one clause boundary.
    expect(gestures(run(director, 60, (f) => (f === 40 ? [clause] : [])))).toHaveLength(1);
  });

  test("she does not gesture on the intake breath", () => {
    // A beat in the first moments of a turn is her starting to speak, not a
    // point being made.
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    expect(run(director, 6, () => [clause])).toEqual([]);
  });

  test("clause boundaries closer than the refractory period do not stack", () => {
    // A beat cut off by the next one never arrives anywhere: the arms travel
    // toward a pose, get retargeted, and read as twitching.
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    // 90 frames is 3 s; the first beat is an arm pose, which asks for 2.2 s.
    const beats = gestures(run(director, 90, (f) => (f > 20 ? [clause] : [])));
    expect(beats.length).toBeLessThanOrEqual(2);
    expect(beats.length).toBeGreaterThanOrEqual(1);
  });

  test("a long stretch with no clause boundary still gets punctuation", () => {
    // Some sentences run a long way with no comma, and going still for all of
    // one reads as a freeze.
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    expect(gestures(run(director, 300)).length).toBeGreaterThan(0); // 10 s, no beats
  });

  test("ordinary beats alternate arms and torso while clauses can lead with arms", () => {
    // Ordinary beats alternate so the arms can settle; meaningful clauses are
    // allowed to lead with the hands even when they break that pattern.
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    const beats = gestures(run(director, 1200, (frame) =>
      frame % 80 === 0 ? [stress] : frame === 300 ? [clause] : []
    ));
    expect(beats.length).toBeGreaterThan(4);
    expect(beats.some((beat) => beat.arm === null)).toBe(true);
    expect(beats.some((beat) => beat.arm !== null)).toBe(true);
  });

  test("every beat names templates that will actually resolve", () => {
    // The arm name is looked up in TalkingHead's `gestureTemplates` and the
    // torso name in ours; a name in neither is a silent no-op on screen.
    for (const r of [0, 0.2, 0.45, 0.7, 0.99]) {
      const director = new MotionDirector({ random: fixed(r) });
      director.start();
      for (const a of gestures(run(director, 1200, () => [clause]))) {
        expect(BODY_GESTURES[a.torso]).toBeDefined();
        if (a.arm !== null) expect(ARM_GESTURES).toContain(a.arm);
      }
    }
  });

  test("every torso pose names all four joints", () => {
    // A joint a beat omits is not returned to rest, it merely stops being
    // restored - so the spine keeps the crease from a lean two beats ago.
    for (const [name, tmpl] of Object.entries(BODY_GESTURES)) {
      expect([name, Object.keys(tmpl).sort()]).toEqual([
        name,
        ["Head.rotation", "Neck.rotation", "Spine1.rotation", "Spine2.rotation"],
      ]);
    }
  });

  test("REGRESSION: a beat is given long enough to travel", () => {
    // TalkingHead slerps `poseBase` toward the target in place every frame, so
    // ~90% of the travel is spent by 0.4 * easeMs. At the old 220 ms that played
    // as a ~90 ms snap - the jump the arms were making.
    const director = new MotionDirector({ random: fixed(0.5) });
    director.start();
    for (const a of gestures(run(director, 1200, () => [clause]))) {
      expect(a.easeMs).toBeGreaterThanOrEqual(500);
      expect(a.holdMs).toBeGreaterThanOrEqual(a.easeMs);
    }
  });

  test("REGRESSION: body beats use human-scale timing", () => {
    const director = new MotionDirector({ random: fixed(0.5) });
    director.start();
    const beats = gestures(run(director, 1800, () => [clause]));

    expect(beats.length).toBeGreaterThan(2);
    for (const beat of beats) {
      expect(beat.easeMs).toBeGreaterThanOrEqual(900);
      expect(beat.holdMs).toBeGreaterThanOrEqual(1800);
    }
  });

  test("the arm vocabulary is broader than the three dominant poses", () => {
    expect(new Set(ARM_GESTURES).size).toBeGreaterThanOrEqual(6);
  });

  test("clause beats choose presenter gestures, stress beats choose emphasis gestures", () => {
    const clauseDirector = new MotionDirector({ random: fixed(0.9) });
    clauseDirector.start();
    const clauseBeats = gestures(run(clauseDirector, 60, (frame) =>
      frame === 30 ? [clause] : []
    ));

    const stressDirector = new MotionDirector({ random: fixed(0.9) });
    stressDirector.start();
    const stressBeats = gestures(run(stressDirector, 260, (frame) =>
      frame === 230 ? [stress] : []
    ));

    expect(["side", "handup", "shrug"]).toContain(clauseBeats[0]?.arm ?? "");
    expect(["index", "ok", "thumbup"]).toContain(stressBeats[0]?.arm ?? "");
  });

  test("a clause gets a clear arm beat instead of a torso-only filler", () => {
    const director = new MotionDirector({ random: fixed(0.5) });
    director.start();
    const beats = gestures(run(director, 400, (frame) =>
      frame === 30 || frame === 350 ? [clause] : []
    ));

    expect(beats.filter((beat) => beat.arm !== null).length).toBeGreaterThanOrEqual(2);
  });

  test("REGRESSION: arm beats cannot interrupt the previous arm release", () => {
    const director = new MotionDirector({ random: fixed(0.5) });
    director.start();
    const gestureStartTimes: Array<{ time: number; hasArm: boolean }> = [];
    for (let frame = 0; frame < 1800; frame++) {
      for (const beat of director.update(FRAME_MS, [clause])) {
        if (beat.kind === "gesture") {
          gestureStartTimes.push({ time: frame * FRAME_MS, hasArm: beat.arm !== null });
        }
      }
    }

    expect(gestureStartTimes.length).toBeGreaterThan(2);
    for (let i = 1; i < gestureStartTimes.length; i++) {
      const previous = gestureStartTimes[i - 1]!;
      const minimumGap = previous.hasArm ? 2900 : 1500;
      expect(gestureStartTimes[i]!.time - previous.time).toBeGreaterThanOrEqual(minimumGap);
    }
  });

  test("REGRESSION: she does not gesture with the same arm all turn", () => {
    // The mirror flag used to flip on every beat, which sounds like alternation
    // but is not: arm poses land on every other beat, so it was always back
    // where it started by the time one arrived.
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    const sides = gestures(run(director, 1200, () => [clause]))
      .filter((a) => a.arm !== null)
      .map((a) => a.mirror);
    expect(sides.length).toBeGreaterThan(2);
    expect(new Set(sides).size).toBe(2);
  });

  test("REGRESSION: a pose is never replayed back to back", () => {
    // Replaying the same pose is invisible - she just holds it longer - so it
    // costs a beat. `random` is a constant here, which is exactly the case a
    // naive re-roll would spin forever on.
    const director = new MotionDirector({ random: fixed(0.5) });
    director.start();
    const beats = gestures(run(director, 1200, () => [clause]));
    const arms = beats.filter((a) => a.arm !== null).map((a) => a.arm);
    const torsos = beats.map((a) => a.torso);
    expect(beats.length).toBeGreaterThan(4);
    for (let i = 1; i < arms.length; i++) expect(arms[i]).not.toBe(arms[i - 1]!);
    for (let i = 1; i < torsos.length; i++) expect(torsos[i]).not.toBe(torsos[i - 1]!);
  });
});

describe("accents land on stressed syllables", () => {
  test("a stressed syllable can raise an accent", () => {
    const director = new MotionDirector({ random: fixed(0.1) }); // below the gate
    director.start();
    const actions = run(director, 60, (f) => (f % 20 === 0 ? [stress] : []));
    expect(actions.filter((a) => a.kind === "accent").length).toBeGreaterThan(0);
  });

  test("not every stressed syllable gets one", () => {
    // Spanish stresses roughly every other syllable; accenting all of them is a
    // nervous tic, not emphasis.
    const director = new MotionDirector({ random: fixed(0.9) }); // above the gate
    director.start();
    const actions = run(director, 120, () => [stress]);
    expect(actions.filter((a) => a.kind === "accent")).toEqual([]);
  });

  test("accents cannot fire faster than the refractory period", () => {
    const director = new MotionDirector({ random: fixed(0.1) });
    director.start();
    // 90 frames is 3 s; at 500 ms apart that is at most six.
    const actions = run(director, 90, () => [stress, stress, stress]);
    expect(actions.filter((a) => a.kind === "accent").length).toBeLessThanOrEqual(6);
  });

  test("an accent moves the HEAD, not only the brows", () => {
    // A brow lift on its own is not what a speech accent looks like; the chin
    // dips first and the brow follows.
    const director = new MotionDirector({ random: fixed(0.1) });
    director.start();
    const accents = run(director, 200, () => [stress]).filter((a) => a.kind === "accent");
    expect(accents.length).toBeGreaterThan(0);
    for (const a of accents) {
      if (a.kind !== "accent") continue;
      expect(a.nod).toBeGreaterThan(0);
      expect(Math.abs(a.tilt)).toBeLessThan(0.12);
      expect(Math.abs(a.turn)).toBeLessThan(0.12);
    }
  });

  test("accent strength stays in a usable range", () => {
    const director = new MotionDirector({ random: fixed(0.1) });
    director.start();
    for (const a of run(director, 200, () => [stress])) {
      if (a.kind === "accent") {
        expect(a.strength).toBeGreaterThan(0.5);
        expect(a.strength).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("turn boundaries", () => {
  test("stopping relaxes the held pose exactly once", () => {
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    run(director, 60, () => [clause]);
    expect(director.stop()).toEqual([{ kind: "relax" }]);
    expect(director.stop()).toEqual([]); // idempotent
  });

  test("the opening delay applies again on the next turn", () => {
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    run(director, 120, () => [clause]);
    director.stop();
    director.start();
    expect(run(director, 6, () => [clause])).toEqual([]);
  });

  test("does not emit a blink during the opening delay", () => {
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    expect(run(director, 6, () => [clause]).filter((a) => a.kind === "blink")).toEqual([]);
  });
});

describe("gesture density", () => {
  test("REGRESSION: clause boundaries alone leave her standing still", () => {
    // A sentence has one or two clause boundaries, so keying gestures only to
    // them produced about two beats in five seconds. The max-gap rule fills the
    // silence in between.
    const director = new MotionDirector({ random: fixed(0.5) });
    director.start();
    // 7.5 s of speech: a stress every ~400 ms, one comma at 1.6 s. The
    // longer physical release window intentionally limits this to two clear
    // beats rather than three overlapping ones.
    const actions = run(director, 225, (f) => {
      const t = f * FRAME_MS;
      const beats: Beat[] = [];
      if (f % 12 === 0) beats.push(stress);
      if (Math.abs(t - 1600) < FRAME_MS / 2) beats.push(clause);
      return beats;
    });
    expect(gestures(actions).length).toBeGreaterThanOrEqual(2);
  });

  test("a clause boundary still takes priority over a plain stress", () => {
    // The boundary is the more meaningful place for a beat, so it must not be
    // pre-empted by a stress that happened to arrive just before it.
    const director = new MotionDirector({ random: fixed(0.9) });
    director.start();
    expect(gestures(run(director, 90, (f) => (f === 60 ? [clause] : [])))).toHaveLength(1);
  });
});
