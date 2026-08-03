/**
 * Per-viseme lip configurations for the painted mouth sprite.
 *
 * Why this exists: the sprite used to be driven by just two numbers - how open
 * and how wide - which is not enough information to tell phonemes apart. /f/ and
 * /s/ are both "slightly open and fairly wide", so they rendered identically; so
 * did /m/ and /p/ and silence. With only that, correct viseme timing still reads
 * as a generic oval opening and closing, i.e. unreadable lips.
 *
 * Each viseme therefore gets an explicit set of visual features - aperture,
 * width, rounding, protrusion, which teeth show, where the tongue is, and the
 * lip-behind-teeth tuck that makes /f/ and /v/ identifiable.
 *
 * Pure and dependency-free: the shape table and blending are unit-tested, the
 * canvas drawing that consumes them is not testable headless.
 */

export interface LipShape {
  /** Vertical parting of the lips. 0 = sealed. */
  aperture: number;
  /** Horizontal extent of the opening. */
  width: number;
  /** 0 = flat slit with spread corners, 1 = circular, corners drawn in. */
  round: number;
  /** Forward pucker: thickens the lip ring and shrinks the opening. */
  protrude: number;
  /** Visibility of the upper teeth row. */
  upperTeeth: number;
  /** Visibility of the lower teeth row. */
  lowerTeeth: number;
  /** Height of the visible tongue. 0 = hidden, 1 = tip at the upper teeth. */
  tongue: number;
  /** Lower lip tucked under the upper teeth - the /f/, /v/ giveaway. */
  lipOnTeeth: number;
}

/** Mouth at rest. */
export const REST: LipShape = {
  aperture: 0, width: 0.55, round: 0.2, protrude: 0,
  upperTeeth: 0, lowerTeeth: 0, tongue: 0, lipOnTeeth: 0,
};

/**
 * Oculus viseme -> how the lips actually look.
 * Values are judgements about visible articulation, not measurements.
 */
export const LIP_SHAPES: Record<string, LipShape> = {
  // Silence and the bilabial stop are both a sealed mouth - as they should be.
  sil: REST,
  PP: { aperture: 0, width: 0.55, round: 0.15, protrude: 0.18, upperTeeth: 0, lowerTeeth: 0, tongue: 0, lipOnTeeth: 0 },
  // /f/, /v/: lower lip tucked under visible upper teeth. Unmistakable.
  FF: { aperture: 0.12, width: 0.5, round: 0.1, protrude: 0, upperTeeth: 0.9, lowerTeeth: 0, tongue: 0, lipOnTeeth: 1 },
  // Tongue between the teeth. Not Spanish (seseo), kept for completeness.
  TH: { aperture: 0.26, width: 0.45, round: 0.2, protrude: 0, upperTeeth: 0.5, lowerTeeth: 0.2, tongue: 0.9, lipOnTeeth: 0 },
  // /t/, /d/: tongue tip up behind the upper teeth, small opening.
  DD: { aperture: 0.3, width: 0.5, round: 0.2, protrude: 0, upperTeeth: 0.62, lowerTeeth: 0.25, tongue: 0.8, lipOnTeeth: 0 },
  // /n/, /l/: like DD but the tongue stays planted and the jaw is lower.
  nn: { aperture: 0.24, width: 0.52, round: 0.18, protrude: 0, upperTeeth: 0.55, lowerTeeth: 0.18, tongue: 0.95, lipOnTeeth: 0 },
  // /k/, /g/, /x/: articulated at the back, so the front looks neutral-open.
  kk: { aperture: 0.4, width: 0.5, round: 0.3, protrude: 0, upperTeeth: 0.35, lowerTeeth: 0.32, tongue: 0.22, lipOnTeeth: 0 },
  // /tʃ/, /ʝ/: palatal, slight pucker with the teeth close.
  CH: { aperture: 0.28, width: 0.38, round: 0.75, protrude: 0.6, upperTeeth: 0.45, lowerTeeth: 0.32, tongue: 0.3, lipOnTeeth: 0 },
  // /s/: narrow slit, both teeth rows nearly meeting.
  SS: { aperture: 0.15, width: 0.62, round: 0.05, protrude: 0, upperTeeth: 0.82, lowerTeeth: 0.62, tongue: 0.2, lipOnTeeth: 0 },
  RR: { aperture: 0.33, width: 0.5, round: 0.25, protrude: 0.1, upperTeeth: 0.35, lowerTeeth: 0.25, tongue: 0.58, lipOnTeeth: 0 },
  // Vowels: the readable ones. Spanish has only five and they look distinct.
  // `tongue` is HEIGHT, not visibility: the tongue always shows in an open
  // mouth, low and flat for /a/, right up at the teeth for /t/, /d/, /n/, /l/.
  aa: { aperture: 1, width: 0.72, round: 0.35, protrude: 0, upperTeeth: 0.5, lowerTeeth: 0.35, tongue: 0.2, lipOnTeeth: 0 },
  E: { aperture: 0.5, width: 0.86, round: 0.1, protrude: 0, upperTeeth: 0.6, lowerTeeth: 0.4, tongue: 0.3, lipOnTeeth: 0 },
  I: { aperture: 0.24, width: 1, round: 0, protrude: 0, upperTeeth: 0.78, lowerTeeth: 0.52, tongue: 0.35, lipOnTeeth: 0 },
  O: { aperture: 0.62, width: 0.42, round: 0.9, protrude: 0.7, upperTeeth: 0.2, lowerTeeth: 0.15, tongue: 0.18, lipOnTeeth: 0 },
  U: { aperture: 0.34, width: 0.27, round: 1, protrude: 1, upperTeeth: 0.1, lowerTeeth: 0.05, tongue: 0.12, lipOnTeeth: 0 },
};

const KEYS: (keyof LipShape)[] = [
  "aperture", "width", "round", "protrude",
  "upperTeeth", "lowerTeeth", "tongue", "lipOnTeeth",
];

/**
 * Straight-line blend between two configurations.
 * Written as `a(1-t) + bt`, not `a + (b-a)t`, so t=0 and t=1 return the
 * endpoints exactly rather than off by a float epsilon.
 */
export function lerpLipShape(a: LipShape, b: LipShape, t: number): LipShape {
  const out = {} as LipShape;
  for (const k of KEYS) out[k] = a[k] * (1 - t) + b[k] * t;
  return out;
}

/**
 * Collapse the live morph influences into one configuration to draw.
 *
 * Takes the two strongest visemes and blends them by relative weight. Using the
 * top two (rather than every active viseme) keeps the result committed to a
 * recognisable shape: averaging all of them is what produced the mushy
 * indistinguishable oval, since the classifier and the easing leave several
 * partially active at once.
 */
export function blendLipShapes(influence: (viseme: string) => number): LipShape {
  let firstKey = "";
  let first = 0;
  let secondKey = "";
  let second = 0;

  for (const key of Object.keys(LIP_SHAPES)) {
    if (key === "sil") continue; // rest is the fallback, never a peak
    const v = influence(key);
    if (v > first) {
      secondKey = firstKey; second = first;
      firstKey = key; first = v;
    } else if (v > second) {
      secondKey = key; second = v;
    }
  }

  if (first <= 0.01) return REST;

  const dominant = LIP_SHAPES[firstKey] ?? REST;
  // Fade in from rest while the leading viseme is still weak, so the mouth
  // eases open instead of snapping to a full shape.
  const strength = Math.min(1, first / 0.6);
  // Weight strictly by relative influence. An extra damping factor here (a 0.5
  // cap, say) makes the crossfade DISCONTINUOUS: the moment the two swap ranks,
  // the base shape swaps too, so the blend jumps across the midpoint instead of
  // passing through it. At equal influence both orderings must agree.
  const shape =
    second > 0.01 && secondKey
      ? lerpLipShape(dominant, LIP_SHAPES[secondKey] ?? REST, second / (first + second))
      : dominant;
  return lerpLipShape(REST, shape, strength);
}
