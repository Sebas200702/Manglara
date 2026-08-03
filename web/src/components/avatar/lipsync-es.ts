/**
 * Spanish text -> Oculus viseme sequence with estimated timings.
 *
 * Why this exists: Gemini Live gives us the assistant's transcript but no
 * phoneme or word timings, so lip-sync used to be derived from the audio with
 * HeadAudio - whose model is trained on English. On Spanish speech that
 * classifier behaves close to an energy detector: the mouth just opens and
 * closes and you cannot read the lips.
 *
 * Spanish orthography is almost perfectly phonemic (with the handful of
 * exceptions handled below), so the *shapes* can be derived reliably straight
 * from the text. TalkingHead ships lipsync modules for en/de/fi/fr/lt only,
 * hence this one.
 *
 * Timing is estimated, not measured: durations below are per-phoneme averages
 * for conversational Spanish (~200 ms per syllable). The caller anchors the
 * sequence to the audio clock, so estimation error stays bounded per chunk
 * instead of accumulating.
 */

/** Oculus viseme IDs, without the `viseme_` prefix TalkingHead adds. */
type Viseme =
  | "sil" | "PP" | "FF" | "TH" | "DD" | "kk" | "CH"
  | "SS" | "nn" | "RR" | "aa" | "E" | "I" | "O" | "U";

/** Average visible duration per viseme, in ms. Vowels carry the syllable. */
const DURATION: Record<Viseme, number> = {
  aa: 115, E: 110, I: 100, O: 115, U: 105,
  PP: 60, DD: 60, kk: 65, RR: 55, nn: 70,
  FF: 75, SS: 80, TH: 70, CH: 80, sil: 90,
};

/** Vowel letters after accent folding. `y` is handled contextually. */
const VOWELS = "aeiou";
/** Weak vowels glide instead of forming their own syllable in a diphthong. */
const WEAK = "iu";

/** Note the length guard: `"aeiou".includes("")` is true, and `next` is "" at
 *  end of input - without this, a word-final `y` looks like a consonant. */
const isVowelChar = (ch: string): boolean => ch.length === 1 && VOWELS.includes(ch);

const VOWEL_VISEMES = new Set<Viseme>(["aa", "E", "I", "O", "U"]);

const VOWEL_VISEME: Record<string, Viseme> = {
  a: "aa", e: "E", i: "I", o: "O", u: "U",
};

/** Accents carry stress, not a different sound - fold them away. `ñ` stays. */
const FOLD: Record<string, string> = {
  á: "a", é: "e", í: "i", ó: "o", ú: "u", ü: "u", à: "a", è: "e", ï: "i",
};

interface Unit {
  viseme: Viseme;
  duration: number;
  /** Gap inserted *before* this unit (word break, punctuation pause). */
  gap: number;
  isVowel: boolean;
  isWeak: boolean;
}

/** One mouth shape to hold for `duration` ms. */
export interface VisemeUnit {
  /** null = mouth at rest: word gap, pause or silence. */
  viseme: Viseme | null;
  duration: number;
}

/** Pause between words - short enough that speech still reads as connected. */
const WORD_GAP = 45;
/** Pause at clause/sentence punctuation, where the mouth also returns to rest. */
const PUNCT_GAP = 170;

/**
 * Convert a Spanish string into mouth shapes to hold, in order.
 * Accepts partial text (Gemini streams the transcript in fragments).
 *
 * Durations are *relative* pacing hints, not absolute schedule times: the
 * caller consumes them against the audio playback clock and adjusts the rate.
 */
export function spanishTextToUnits(text: string): VisemeUnit[] {
  if (!text) return [];

  // Fold accents and lowercase, but keep `ñ` and `ü` distinct where they matter.
  const s = Array.from(text.toLowerCase())
    .map((c) => (c === "ü" || c === "ñ" ? c : FOLD[c] ?? c))
    .join("");

  const units: Unit[] = [];
  let gap = 0;

  const push = (viseme: Viseme, scale = 1): void => {
    const prev = units[units.length - 1];
    // Merge a repeated viseme instead of emitting two identical shapes back to
    // back (e.g. "innecesario", or a consonant meeting the same viseme across a
    // word boundary) - two in a row read as one longer hold anyway.
    if (prev && prev.viseme === viseme && gap === 0) {
      prev.duration += DURATION[viseme] * scale * 0.4;
      return;
    }
    const isVowel = VOWEL_VISEMES.has(viseme);
    units.push({
      viseme,
      duration: DURATION[viseme] * scale,
      gap,
      isVowel,
      isWeak: false,
    });
    gap = 0;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1] ?? "";
    const isFront = next === "e" || next === "i";

    // --- separators -------------------------------------------------------
    if (c === " " || c === "\n" || c === "\t") {
      gap = Math.max(gap, WORD_GAP);
      i += 1;
      continue;
    }
    if (".,;:!?¡¿…-–—\"'()".includes(c)) {
      // Close the mouth at a real pause; that boundary is a strong readability
      // cue and it keeps long utterances from looking like one endless blur.
      if (".;:!?…".includes(c)) {
        gap = Math.max(gap, PUNCT_GAP);
        push("sil");
        gap = WORD_GAP;
      } else {
        gap = Math.max(gap, WORD_GAP);
      }
      i += 1;
      continue;
    }

    // --- digraphs ---------------------------------------------------------
    if (c === "c" && next === "h") { push("CH"); i += 2; continue; }
    if (c === "l" && next === "l") { push("CH"); i += 2; continue; } // /ʝ/, palatal
    if (c === "r" && next === "r") { push("RR"); i += 2; continue; }
    // `qu`/`gu` before e/i: the u is silent ("queso", "guitarra").
    if (c === "q" && next === "u" && (s[i + 2] === "e" || s[i + 2] === "i")) {
      push("kk"); i += 2; continue;
    }
    if (c === "g" && next === "u" && (s[i + 2] === "e" || s[i + 2] === "i")) {
      push("kk"); i += 2; continue;
    }
    // `gü` before e/i: the u *is* pronounced ("bilingüe").
    if (c === "g" && next === "ü") { push("kk"); push("U"); i += 2; continue; }

    // --- vowels -----------------------------------------------------------
    if (VOWELS.includes(c)) {
      push(VOWEL_VISEME[c]);
      const u = units[units.length - 1];
      if (u) u.isWeak = WEAK.includes(c);
      i += 1;
      continue;
    }
    if (c === "ü") { push("U"); i += 1; continue; }

    // `y` is a vowel on its own or word-final ("y", "hay"), a consonant before
    // a vowel ("ya", "mayo").
    if (c === "y") {
      if (isVowelChar(next)) push("CH");
      else { push("I"); const u = units[units.length - 1]; if (u) u.isWeak = true; }
      i += 1;
      continue;
    }

    // --- consonants -------------------------------------------------------
    switch (c) {
      // Spanish `v` is bilabial, same as `b` - not the labiodental English /v/.
      case "p": case "b": case "v": case "m": push("PP"); break;
      case "f": push("FF"); break;
      case "t": case "d": push("DD"); break;
      case "n": case "ñ": push("nn"); break;
      case "l": push("nn"); break;
      case "r": push("RR"); break;
      case "s": push("SS"); break;
      // Seseo (Latin American): `z` and `c`+e/i are /s/.
      case "z": push("SS"); break;
      case "c": push(isFront ? "SS" : "kk"); break;
      // `j` and `g`+e/i are the velar /x/; `g` elsewhere is /g/. Same viseme.
      case "j": case "g": case "k": case "q": push("kk"); break;
      case "x": push("kk"); push("SS"); break;
      case "w": push("U"); break;
      case "h": break; // silent (the `ch` digraph was handled above)
      default: break;  // digits, emoji, unknown scripts: no mouth shape
    }
    i += 1;
  }

  if (!units.length) return [];

  // Diphthongs: a weak vowel touching another vowel is a glide, so it gets a
  // fraction of a full syllable. Without this, "bueno" or "tiene" play as two
  // slow separate vowels and the pacing drifts badly from the audio.
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    if (!u.isVowel || !u.isWeak) continue;
    const before = units[k - 1];
    const after = units[k + 1];
    const glides =
      (before?.isVowel && before.gap === 0 && u.gap === 0) ||
      (after?.isVowel && after.gap === 0);
    if (glides) u.duration *= 0.55;
  }

  // Flatten to a plain hold-this-shape list. Gaps and `sil` both become an
  // explicit rest unit, so the consumer never has to special-case them.
  const out: VisemeUnit[] = [];
  for (const u of units) {
    if (u.gap > 0) out.push({ viseme: null, duration: u.gap });
    out.push({
      viseme: u.viseme === "sil" ? null : u.viseme,
      duration: u.duration,
    });
  }
  return out;
}

/** Total time the units would take at their natural pace, in ms. */
export function unitsDuration(units: VisemeUnit[]): number {
  let t = 0;
  for (const u of units) t += u.duration;
  return t;
}
