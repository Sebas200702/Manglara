import { describe, expect, test } from "bun:test";
import { spanishTextToUnits, unitsDuration } from "./lipsync-es";

/** Just the mouth shapes, dropping rest units, for readable assertions. */
const shapes = (text: string): string =>
  spanishTextToUnits(text)
    .filter((u) => u.viseme)
    .map((u) => u.viseme)
    .join(" ");

describe("Spanish orthography rules", () => {
  test("silent u in qu/gu before e/i", () => {
    // "queso" is /keso/ and "guitarra" /gitara/ - the u is never mouthed.
    expect(shapes("queso")).toBe("kk E SS O");
    expect(shapes("guitarra")).toBe("kk I DD aa RR aa");
    // ...but it IS pronounced elsewhere, and when written ü.
    expect(shapes("agua")).toBe("aa kk U aa");
    expect(shapes("bilingüe")).toBe("PP I nn I nn kk U E");
  });

  test("seseo: z and c before e/i are /s/", () => {
    expect(shapes("cinco")).toBe("SS I nn kk O");
    expect(shapes("zapato")).toBe("SS aa PP aa DD O");
    // c before a/o/u stays velar.
    expect(shapes("casa")).toBe("kk aa SS aa");
  });

  test("digraphs ch, ll, rr are single sounds", () => {
    expect(shapes("chocolate")).toBe("CH O kk O nn aa DD E");
    expect(shapes("llave")).toBe("CH aa PP E");
    // rr is one tap, not two.
    expect(shapes("carro")).toBe("kk aa RR O");
  });

  test("h is silent, but ch was already consumed", () => {
    expect(shapes("hola")).toBe("O nn aa");
    expect(shapes("hay")).toBe("aa I");
    expect(shapes("hecho")).toBe("E CH O");
  });

  test("x is /ks/", () => {
    expect(shapes("México")).toBe("PP E kk SS I kk O");
  });

  test("v is bilabial in Spanish, same as b", () => {
    // Not the labiodental FF an English-trained mapping would give.
    expect(shapes("vaca")).toBe("PP aa kk aa");
    expect(shapes("bata")).toBe("PP aa DD aa");
  });

  test("accents fold away, ñ does not", () => {
    expect(shapes("erosión")).toBe(shapes("erosion"));
    expect(shapes("año")).toBe("aa nn O");
  });

  test("REGRESSION: word-final y is a vowel, not a consonant", () => {
    // `"aeiou".includes("")` is true in JS, so an unguarded lookahead made a
    // final y (where next === "") parse as the consonant CH.
    expect(shapes("hay")).toBe("aa I");
    expect(shapes("voy")).toBe("PP O I");
    expect(shapes("y")).toBe("I");
    // Before a vowel it really is the consonant.
    expect(shapes("ya")).toBe("CH aa");
    expect(shapes("mayo")).toBe("PP aa CH O");
  });

  test("repeated identical shapes merge into one longer hold", () => {
    // "innecesario": the two n's are one mouth shape, not two.
    const units = spanishTextToUnits("innecesario").filter((u) => u.viseme);
    expect(units.map((u) => u.viseme).join(" ")).toBe("I nn E SS E SS aa RR I O");
    // The merged nn is held longer than a lone one.
    const merged = units[1]!;
    const lone = spanishTextToUnits("ana").filter((u) => u.viseme)[1]!;
    expect(merged.duration).toBeGreaterThan(lone.duration);
  });
});

describe("pacing", () => {
  test("weak vowels in a diphthong are glides, not full syllables", () => {
    const bueno = spanishTextToUnits("bueno").filter((u) => u.viseme);
    const u = bueno.find((x) => x.viseme === "U")!;
    const e = bueno.find((x) => x.viseme === "E")!;
    expect(u.duration).toBeLessThan(e.duration);

    // A lone strong u is NOT shortened.
    const uno = spanishTextToUnits("luna").filter((u) => u.viseme);
    expect(uno.find((x) => x.viseme === "U")!.duration).toBeGreaterThan(u.duration);
  });

  test("pace lands in the range of conversational Spanish", () => {
    for (const phrase of [
      "chocolate",
      "el manglar protege la costa",
      "captura carbono y frena la erosion",
    ]) {
      const vowels = (phrase.match(/[aeiou]/g) ?? []).length;
      const msPerVowel = unitsDuration(spanishTextToUnits(phrase)) / vowels;
      // Conversational Spanish sits near 200 ms/syllable.
      expect(msPerVowel).toBeGreaterThan(120);
      expect(msPerVowel).toBeLessThan(280);
    }
  });

  test("punctuation inserts a rest, words a shorter one", () => {
    const sentence = spanishTextToUnits("hola. si");
    const rests = sentence.filter((u) => u.viseme === null);
    expect(rests.length).toBeGreaterThan(0);
    // The sentence break is the longest rest in there.
    const longest = Math.max(...rests.map((r) => r.duration));
    const wordGap = spanishTextToUnits("hola si").filter((u) => !u.viseme)[0]!;
    expect(longest).toBeGreaterThan(wordGap.duration);
  });
});

describe("stress (prosody for the body, not the mouth)", () => {
  /** The viseme of the stressed syllable, or "-" if the word has no stress. */
  const stressOf = (text: string): string =>
    spanishTextToUnits(text)
      .filter((u) => u.stressed)
      .map((u) => u.viseme)
      .join(" ") || "-";

  test("a written accent IS the stress, wherever it falls", () => {
    expect(stressOf("canción")).toBe("O"); // can-CIÓN
    expect(stressOf("árbol")).toBe("aa"); // ÁR-bol, against the aguda rule
    expect(stressOf("bambú")).toBe("U");
  });

  test("words ending in a vowel, n or s are stressed on the penultimate", () => {
    expect(stressOf("hola")).toBe("O"); // HO-la
    expect(stressOf("cantan")).toBe("aa"); // CAN-tan
    expect(stressOf("manglares")).toBe("aa"); // man-GLA-res
  });

  test("anything else is stressed on the last syllable", () => {
    expect(stressOf("papel")).toBe("E"); // pa-PEL
    expect(stressOf("verdad")).toBe("aa"); // ver-DAD
  });

  test("a diphthong is one syllable, stressed on its strong vowel", () => {
    // "bueno" is BUE-no: two syllables, not three, and the beat lands on the e.
    expect(stressOf("bueno")).toBe("E");
    expect(stressOf("tierra")).toBe("E");
  });

  test("unstressed monosyllables do not carry a beat", () => {
    // Articles, prepositions and clitics lean on the word next to them. Nodding
    // on "de" and "la" puts the emphasis on the joins instead of the meaning.
    expect(stressOf("de")).toBe("-");
    expect(stressOf("la")).toBe("-");
    expect(stressOf("que")).toBe("-");
    // ...but a content monosyllable does.
    expect(stressOf("sol")).toBe("O");
  });

  test("every word contributes at most one stress", () => {
    const text = "Manglara teje redes verdes con las comunidades del Caribe";
    const units = spanishTextToUnits(text);
    const stressed = units.filter((u) => u.stressed).length;
    // Nine words, two of them ("con", "las", "del") unstressed function words.
    expect(stressed).toBeGreaterThan(4);
    expect(stressed).toBeLessThanOrEqual(text.split(" ").length);
  });

  test("stress never lands on a rest or a consonant", () => {
    for (const u of spanishTextToUnits("¡Hola! Soy Manglara, ¿cómo estás?")) {
      if (u.stressed) expect(u.vowel).toBe(true);
    }
  });
});

describe("degenerate input", () => {
  test("empty and shape-less input yields no units", () => {
    expect(spanishTextToUnits("")).toEqual([]);
    expect(spanishTextToUnits("123 🙂")).toHaveLength(0);
  });

  test("every unit has a strictly positive duration", () => {
    // A zero-duration unit would let the driver's retire-loop chew through the
    // whole queue within a single frame.
    for (const u of spanishTextToUnits("¡Hola! ¿Que tal? Bien... gracias, 42 🙂")) {
      expect(u.duration).toBeGreaterThan(0);
    }
  });
});
