import { describe, expect, test } from "bun:test";
import { LIP_SHAPES, REST, blendLipShapes, lerpLipShape } from "./lip-shapes";
import type { LipShape } from "./lip-shapes";

const KEYS: (keyof LipShape)[] = [
  "aperture", "width", "round", "protrude",
  "upperTeeth", "lowerTeeth", "tongue", "lipOnTeeth",
];

const distance = (a: LipShape, b: LipShape): number =>
  Math.sqrt(KEYS.reduce((sum, k) => sum + (a[k] - b[k]) ** 2, 0));

/**
 * Homophenous groups: sounds that genuinely look the same from outside, so no
 * renderer can or should separate them. /t/, /d/, /n/, /l/ and /θ/ share one
 * articulation as far as the visible mouth goes - human lipreaders cannot tell
 * them apart either. Demanding separation inside a group would be demanding a
 * lie; the meaningful requirement is separation ACROSS groups.
 */
const GROUPS: string[][] = [
  ["sil", "PP"],        // sealed lips
  ["FF"],               // labiodental
  ["TH", "DD", "nn"],   // dental/alveolar, tongue tip forward
  ["kk"],               // velar
  ["CH"],               // palatal
  ["SS"],               // sibilant
  ["RR"],               // rhotic
  ["aa"], ["E"], ["I"], ["O"], ["U"], // vowels: each must stand alone
];

const groupOf = (key: string): number => GROUPS.findIndex((g) => g.includes(key));

describe("shapes are visually distinguishable", () => {
  // This is the user-facing requirement, as a test: you must be able to tell
  // what she is saying from the lips. The old renderer had only two degrees of
  // freedom (open, wide), so /f/ and /s/ - and /m/ and /p/ - were identical.
  test("the table covers every viseme exactly once", () => {
    expect(GROUPS.flat().sort()).toEqual(Object.keys(LIP_SHAPES).sort());
  });

  test("visemes from different groups are separated", () => {
    const keys = Object.keys(LIP_SHAPES);
    const tooClose: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const ka = keys[i]!;
        const kb = keys[j]!;
        if (groupOf(ka) === groupOf(kb)) continue;
        const d = distance(LIP_SHAPES[ka]!, LIP_SHAPES[kb]!);
        if (d < 0.25) tooClose.push(`${ka}/${kb}=${d.toFixed(2)}`);
      }
    }
    expect(tooClose).toEqual([]);
  });

  test("the five Spanish vowels are strongly separated", () => {
    // Vowels carry most of the readable information in Spanish.
    const vowels = ["aa", "E", "I", "O", "U"];
    for (let i = 0; i < vowels.length; i++) {
      for (let j = i + 1; j < vowels.length; j++) {
        const d = distance(LIP_SHAPES[vowels[i]!]!, LIP_SHAPES[vowels[j]!]!);
        expect(d).toBeGreaterThan(0.3);
      }
    }
  });

  test("pairs the old two-parameter renderer confused are now distinct", () => {
    // Each of these was "slightly open, fairly wide" and so drew identically.
    expect(distance(LIP_SHAPES.FF!, LIP_SHAPES.SS!)).toBeGreaterThan(0.5);
    expect(distance(LIP_SHAPES.DD!, LIP_SHAPES.SS!)).toBeGreaterThan(0.3);
    expect(distance(LIP_SHAPES.I!, LIP_SHAPES.E!)).toBeGreaterThan(0.3);
    expect(distance(LIP_SHAPES.O!, LIP_SHAPES.U!)).toBeGreaterThan(0.3);
  });

  test("articulation cues are present where they identify the sound", () => {
    // /f/, /v/: lower lip under the upper teeth.
    expect(LIP_SHAPES.FF!.lipOnTeeth).toBeGreaterThan(0.8);
    for (const [k, s] of Object.entries(LIP_SHAPES)) {
      if (k !== "FF") expect(s.lipOnTeeth).toBe(0);
    }
    // Rounded vowels protrude; spread ones do not.
    expect(LIP_SHAPES.U!.protrude).toBeGreaterThan(LIP_SHAPES.O!.protrude);
    expect(LIP_SHAPES.I!.protrude).toBe(0);
    expect(LIP_SHAPES.E!.protrude).toBe(0);
    // Alveolars show the tongue; back consonants and rounded vowels do not.
    expect(LIP_SHAPES.nn!.tongue).toBeGreaterThan(0.7);
    expect(LIP_SHAPES.DD!.tongue).toBeGreaterThan(0.7);
    expect(LIP_SHAPES.U!.tongue).toBeLessThan(0.2);
    // Widest is /i/, narrowest is /u/.
    const widths = Object.values(LIP_SHAPES).map((s) => s.width);
    expect(LIP_SHAPES.I!.width).toBe(Math.max(...widths));
    expect(LIP_SHAPES.U!.width).toBe(Math.min(...widths));
    // /a/ opens most.
    expect(LIP_SHAPES.aa!.aperture).toBe(
      Math.max(...Object.values(LIP_SHAPES).map((s) => s.aperture))
    );
  });

  test("silence and the bilabial stop are both sealed, deliberately", () => {
    // A closed mouth is a closed mouth - these two SHOULD look alike.
    expect(LIP_SHAPES.sil!.aperture).toBe(0);
    expect(LIP_SHAPES.PP!.aperture).toBe(0);
  });
});

describe("blending", () => {
  const only = (key: string, value: number) => (v: string) => (v === key ? value : 0);

  test("no influence leaves the mouth at rest", () => {
    expect(blendLipShapes(() => 0)).toEqual(REST);
    expect(blendLipShapes(only("aa", 0.005))).toEqual(REST);
  });

  test("a single strong viseme renders essentially its own shape", () => {
    const shape = blendLipShapes(only("aa", 0.8));
    expect(distance(shape, LIP_SHAPES.aa!)).toBeLessThan(0.05);
  });

  test("a weak viseme eases out of rest rather than snapping", () => {
    const weak = blendLipShapes(only("aa", 0.15));
    const strong = blendLipShapes(only("aa", 0.8));
    expect(weak.aperture).toBeGreaterThan(0);
    expect(weak.aperture).toBeLessThan(strong.aperture);
  });

  test("blending is continuous as one viseme replaces another", () => {
    // A crossfade must not jump: adjacent samples stay close together.
    let prev = blendLipShapes((v) => (v === "aa" ? 0.7 : 0));
    for (let step = 1; step <= 10; step++) {
      const t = step / 10;
      const cur = blendLipShapes((v) =>
        v === "aa" ? 0.7 * (1 - t) : v === "U" ? 0.7 * t : 0
      );
      expect(distance(prev, cur)).toBeLessThan(0.45);
      prev = cur;
    }
    expect(distance(prev, LIP_SHAPES.U!)).toBeLessThan(0.25);
  });

  test("the dominant viseme, not the average, decides the shape", () => {
    // Averaging everything is what produced the mushy oval.
    const shape = blendLipShapes((v) =>
      v === "U" ? 0.7 : v === "I" ? 0.2 : v === "E" ? 0.15 : 0
    );
    expect(distance(shape, LIP_SHAPES.U!)).toBeLessThan(
      distance(shape, LIP_SHAPES.I!)
    );
    expect(shape.width).toBeLessThan(0.5); // still a pucker, not a spread
  });

  test("lerp endpoints are exact", () => {
    expect(lerpLipShape(LIP_SHAPES.aa!, LIP_SHAPES.U!, 0)).toEqual(LIP_SHAPES.aa!);
    expect(lerpLipShape(LIP_SHAPES.aa!, LIP_SHAPES.U!, 1)).toEqual(LIP_SHAPES.U!);
  });
});
