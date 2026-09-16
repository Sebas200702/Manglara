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
  /** This vowel carried a written accent (á, é, í, ó, ú) before folding. */
  accented: boolean;
  /** Syllable nucleus carrying the word's stress (see markWordStress). */
  stressed: boolean;
  /** Punctuation strength of `gap`, 0 for a plain word break. */
  boundary: number;
}

/** One mouth shape to hold for `duration` ms. */
export interface VisemeUnit {
  /** null = mouth at rest: word gap, pause or silence. */
  viseme: Viseme | null;
  duration: number;
  /**
   * True when this unit is a syllable nucleus (a vowel).
   *
   * Syllable nuclei are what the audio can actually be aligned to: each one is
   * an energy peak in the waveform, so the consumer can pin them to the beats it
   * hears instead of laying the sequence out on an averaged clock. See
   * viseme-driver's audio-anchored path.
   */
  vowel?: boolean;
  /**
   * True when this vowel is the stressed syllable of its word.
   *
   * Prosody, not articulation: nothing about the mouth changes here. It is what
   * the body runs on - a speaker's beat gestures and brow accents land on
   * stressed syllables, so `viseme-driver` turns these into `Beat`s as the
   * playback cursor crosses them and `motion-director` decides what to do with
   * them. Without it the body can only gesture on a timer, which is the single
   * thing that most makes a talking head read as a puppet.
   */
  stressed?: boolean;
  /**
   * On a rest unit: how strong a punctuation boundary it is, 0..1. Zero (the
   * default) is a plain word break.
   *
   * Prosody again, and it cannot be recovered from the duration. A comma is the
   * commonest clause boundary in speech and the most natural place for a hand
   * beat, but its *pause* is barely longer than a word gap - so the mouth quite
   * rightly does not stop for it, and a consumer looking only at rest lengths
   * would never see it.
   */
  boundary?: number;
}

/** Pause between words - short enough that speech still reads as connected. */
const WORD_GAP = 45;
/** Pause at clause/sentence punctuation, where the mouth also returns to rest. */
const PUNCT_GAP = 170;
/** Boundary strength of a comma-class mark: a clause break, not a full stop. */
const CLAUSE_BOUNDARY = 0.55;
/** Boundary strength of a sentence stop. */
const SENTENCE_BOUNDARY = 1;

/** Vowels that carry a written accent, i.e. the word's stress is already marked. */
const ACCENTED = "áéíóú";

/**
 * Monosyllables that carry no stress of their own.
 *
 * Spanish stress rules place the accent inside a word, but a one-syllable word
 * only has stress if it is a content word. Articles, prepositions, conjunctions
 * and clitic pronouns lean on the word next to them, and treating every "de",
 * "la" and "que" as an accent means the head nods on the function words instead
 * of on what is being said. Words with a written accent (él, sí, más, tú) are
 * never in this list - the accent mark is exactly the distinction it makes, and
 * it is checked before this set is consulted.
 */
const UNSTRESSED_MONOSYLLABLES = new Set([
  "el", "la", "los", "las", "lo", "un", "de", "del", "al", "y", "e", "o", "u",
  "que", "se", "me", "te", "le", "les", "nos", "os", "su", "sus", "mi", "tu",
  "con", "por", "sin", "en", "a", "ni", "si", "como", "cuando", "donde",
]);

/**
 * Mark the stressed syllable of one word, in place.
 *
 * Standard Spanish rules, in the order they override each other:
 *  1. a written accent IS the stress, wherever it falls;
 *  2. a word ending in a vowel, `n` or `s` is stressed on the penultimate
 *     syllable (llana);
 *  3. anything else on the last syllable (aguda).
 *
 * Syllables are counted from the vowel units: a run of adjacent vowels is one
 * syllable (a diphthong), and its nucleus is the strong vowel - `bueno` is two
 * syllables with the stress on the `e`, not three with it on the `u`.
 */
function markWordStress(word: string, unitsOfWord: Unit[]): void {
  const nuclei: Unit[] = [];
  for (let i = 0; i < unitsOfWord.length; i++) {
    if (!unitsOfWord[i]!.isVowel) continue;
    let j = i;
    while (j + 1 < unitsOfWord.length && unitsOfWord[j + 1]!.isVowel) j++;
    const run = unitsOfWord.slice(i, j + 1);
    nuclei.push(
      run.find((u) => u.accented) ?? run.find((u) => !u.isWeak) ?? run[run.length - 1]!
    );
    i = j;
  }
  if (!nuclei.length) return;

  const marked = nuclei.find((u) => u.accented);
  if (marked) {
    marked.stressed = true;
    return;
  }
  if (nuclei.length === 1) {
    if (!UNSTRESSED_MONOSYLLABLES.has(word)) nuclei[0]!.stressed = true;
    return;
  }
  const last = word[word.length - 1] ?? "";
  const llana = VOWELS.includes(last) || last === "n" || last === "s";
  nuclei[nuclei.length - (llana ? 2 : 1)]!.stressed = true;
}

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
  // `accentAt` records which positions of the FOLDED string carried an accent:
  // folding is what makes the text easy to read phonetically, but the accent is
  // the one thing that says where the stress is (see markWordStress). Built by
  // walking code POINTS and indexing by code UNIT, so an emoji in the transcript
  // cannot slide the two out of alignment.
  let s = "";
  const accentAt: boolean[] = [];
  for (const ch of Array.from(text.toLowerCase())) {
    const folded = ch === "ü" || ch === "ñ" ? ch : FOLD[ch] ?? ch;
    for (let k = 0; k < folded.length; k++) accentAt.push(ACCENTED.includes(ch));
    s += folded;
  }

  const units: Unit[] = [];
  let gap = 0;
  /** Punctuation strength of the pending gap (see VisemeUnit.boundary). */
  let gapBoundary = 0;
  /** Where the word being read starts in `s`, and which unit it starts at. */
  let wordCharStart = 0;
  let wordStart = 0;

  /** Close the word that ends at `end` (exclusive) and mark its stress. */
  const endWord = (end: number): void => {
    const word = s.slice(wordCharStart, end);
    if (word) markWordStress(word, units.slice(wordStart));
    wordCharStart = end + 1;
    wordStart = units.length;
  };

  const push = (viseme: Viseme, scale = 1, accented = false): void => {
    const prev = units[units.length - 1];
    // Merge a repeated viseme instead of emitting two identical shapes back to
    // back (e.g. "innecesario", or a consonant meeting the same viseme across a
    // word boundary) - two in a row read as one longer hold anyway.
    if (prev && prev.viseme === viseme && gap === 0) {
      prev.duration += DURATION[viseme] * scale * 0.4;
      if (accented) prev.accented = true;
      return;
    }
    const isVowel = VOWEL_VISEMES.has(viseme);
    units.push({
      viseme,
      duration: DURATION[viseme] * scale,
      gap,
      isVowel,
      isWeak: false,
      accented,
      stressed: false,
      boundary: gapBoundary,
    });
    gap = 0;
    gapBoundary = 0;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1] ?? "";
    const isFront = next === "e" || next === "i";

    // --- separators -------------------------------------------------------
    if (c === " " || c === "\n" || c === "\t") {
      endWord(i);
      gap = Math.max(gap, WORD_GAP);
      i += 1;
      continue;
    }
    if (".,;:!?¡¿…-–—\"'()".includes(c)) {
      endWord(i);
      // Close the mouth at a real pause; that boundary is a strong readability
      // cue and it keeps long utterances from looking like one endless blur.
      if (".;:!?…".includes(c)) {
        gap = Math.max(gap, PUNCT_GAP);
        gapBoundary = Math.max(gapBoundary, SENTENCE_BOUNDARY);
        push("sil");
        gap = WORD_GAP;
        wordStart = units.length; // the rest belongs to no word
      } else {
        // A comma barely lengthens the pause - the mouth should not stop for it
        // - but it IS a clause boundary, and the body needs to know.
        gap = Math.max(gap, WORD_GAP);
        gapBoundary = Math.max(gapBoundary, CLAUSE_BOUNDARY);
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
      push(VOWEL_VISEME[c], 1, accentAt[i] === true);
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

  // A fragment usually ends mid-sentence with no trailing separator, so the last
  // word only gets its stress here.
  endWord(s.length);

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
    if (u.gap > 0) {
      out.push({ viseme: null, duration: u.gap, vowel: false, boundary: u.boundary });
    }
    out.push({
      viseme: u.viseme === "sil" ? null : u.viseme,
      duration: u.duration,
      vowel: u.isVowel && u.viseme !== "sil",
      stressed: u.stressed,
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
