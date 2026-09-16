import { describe, expect, test } from "bun:test";
import { MOUTH_LEAD_MS, VisemeDriver } from "./viseme-driver";
import { spanishTextToUnits, unitsDuration } from "./lipsync-es";

describe("AudioVisemeEngine (Real-Time WebAudio Lip Sync)", () => {
  test("silence returns null (mouth sealed shut)", () => {
    const driver = new VisemeDriver();
    // Zero volume / silence
    const viseme = driver.tickFrame({ dt: 16, volume: 0 });
    expect(viseme).toBeNull();
    expect(driver.currentLipShape.aperture).toBe(0);
  });

  test("low-frequency vowel spectrum selects open/rounded viseme", () => {
    const driver = new VisemeDriver();
    // Simulate low-frequency spectrum (/o/, /u/)
    const freq = new Uint8Array(64);
    for (let i = 0; i < 6; i++) freq[i] = 220; // High low-frequency energy
    for (let i = 6; i < 64; i++) freq[i] = 10;

    let viseme: string | null = null;
    for (let f = 0; f < 5; f++) {
      viseme = driver.tickFrame({ dt: 16, frequencyData: freq, volume: 0.5 });
    }
    expect(viseme).toBe("O");
    expect(driver.currentLipShape.aperture).toBeGreaterThan(0.2);
  });

  test("high-frequency sibilant spectrum selects sibilant viseme (/s/, /f/)", () => {
    const driver = new VisemeDriver();
    // Simulate high-frequency spectrum (/s/)
    const freq = new Uint8Array(64);
    for (let i = 0; i < 24; i++) freq[i] = 10;
    for (let i = 24; i < 64; i++) freq[i] = 230; // High frequency energy

    const viseme = driver.tickFrame({ dt: 16, frequencyData: freq, volume: 0.5 });
    expect(viseme).toBe("SS");
  });

  test("mid-frequency spectrum selects front vowel (/e/, /i/)", () => {
    const driver = new VisemeDriver();
    // Simulate mid-frequency spectrum (/i/, /e/)
    const freq = new Uint8Array(64);
    for (let i = 0; i < 6; i++) freq[i] = 20;
    for (let i = 6; i < 24; i++) freq[i] = 220; // High mid-frequency energy
    for (let i = 24; i < 64; i++) freq[i] = 30;

    const viseme = driver.tickFrame({ dt: 16, frequencyData: freq, volume: 0.5 });
    expect(["I", "E"]).toContain(viseme!);
  });

  test("instant response when voice pauses and resumes", () => {
    const driver = new VisemeDriver();

    // Voice playing
    for (let f = 0; f < 5; f++) {
      driver.tickFrame({ dt: 16, volume: 0.6 });
    }
    expect(driver.shape).not.toBeNull();

    // Voice pauses (silence)
    const silent = driver.tickFrame({ dt: 16, volume: 0 });
    expect(silent).toBeNull();
    // Smooth closure over a couple frames
    for (let f = 0; f < 5; f++) {
      driver.tickFrame({ dt: 16, volume: 0 });
    }
    expect(driver.currentLipShape.aperture).toBe(0);
  });

  test("mouth shapes transition instead of snapping between vowels", () => {
    const driver = new VisemeDriver();
    const low = new Uint8Array(64);
    const mid = new Uint8Array(64);
    for (let i = 0; i < 6; i++) low[i] = 220;
    for (let i = 6; i < 24; i++) mid[i] = 220;

    for (let frame = 0; frame < 8; frame++) {
      driver.tickFrame({ dt: 16, frequencyData: low, volume: 0.5 });
    }
    const before = driver.currentLipShape.aperture;
    driver.tickFrame({ dt: 16, frequencyData: mid, volume: 0.5 });

    expect(Math.abs(driver.currentLipShape.aperture - before)).toBeLessThan(0.35);
  });

  test("reset clears engine state", () => {
    const driver = new VisemeDriver();
    driver.tickFrame({ dt: 16, volume: 0.8 });
    driver.reset();
    expect(driver.shape).toBeNull();
    expect(driver.currentLipShape.aperture).toBe(0);
  });
});

describe("VisemeDriver (transcript scheduling)", () => {
  // Durations are comfortably larger than MOUTH_LEAD_MS so every unit can be
  // probed at a non-negative heard position.
  const seq = [
    { viseme: "aa", duration: 400 }, //  speech [0, 400)
    { viseme: null, duration: 200 }, //  speech [400, 600)   rest / word gap
    { viseme: "PP", duration: 300 }, //  speech [600, 900)
    { viseme: "O", duration: 400 }, //   speech [900, 1300)
  ];
  const TIMELINE = 1300;

  const at = (driver: VisemeDriver, playedMs: number) =>
    driver.tick({ dt: 16, speaking: true, audioFedMs: 100000, playedMs });

  /** Heard position at which the mouth sits at speech position `speechMs`. */
  const heardFor = (speechMs: number, rate = 1) => speechMs * rate - MOUTH_LEAD_MS;

  test("the played audio position selects the scheduled viseme", () => {
    const driver = new VisemeDriver();
    driver.seedRate(1); // explicit 1:1, so only the lead shifts the mapping
    driver.enqueue(seq);
    expect(at(driver, heardFor(200))).toBe("aa");
    expect(at(driver, heardFor(500))).toBeNull(); // rest between words
    expect(at(driver, heardFor(700))).toBe("PP"); // bilabial closure, not a vowel
    expect(at(driver, heardFor(1000))).toBe("O");
  });

  test("the mouth leads the ear, so shapes never read as late", () => {
    const driver = new VisemeDriver();
    driver.seedRate(1);
    driver.enqueue(seq);
    // The /p/ closure is scheduled at speech-time 600. Find the earliest heard
    // position at which the lips have already made it: with any positive lead
    // that must happen BEFORE the ear reaches 600. Asserted as a property, so
    // this test survives future re-tuning of MOUTH_LEAD_MS.
    let firstPP: number | null = null;
    for (let p = 0; p <= 600; p += 5) {
      if (at(driver, p) === "PP") { firstPP = p; break; }
    }
    expect(firstPP).not.toBeNull();
    expect(firstPP!).toBeLessThan(600);
  });

  test("the cursor never runs backwards or past the enqueued timeline", () => {
    const driver = new VisemeDriver();
    driver.seedRate(1);
    driver.enqueue(seq);
    at(driver, heardFor(1200)); // jump near the end
    // A late/again-arriving smaller position must not rewind the mouth.
    expect(at(driver, 50)).toBe("O");
    // Beyond the timeline it holds the last shape rather than going silent.
    expect(at(driver, 100000)).toBe("O");
  });

  test("not speaking eases to rest and returns null", () => {
    const driver = new VisemeDriver();
    driver.enqueue(seq);
    at(driver, heardFor(200));
    expect(driver.tick({ dt: 16, speaking: false })).toBeNull();
  });

  test("endTurn learns the tempo from audio-vs-estimate", () => {
    const driver = new VisemeDriver();
    // A long turn: enough evidence for the measurement to be trusted in full.
    const units = Array.from({ length: 12 }, () => seq).flat(); // ~15.6s estimated
    driver.enqueue(units);
    const timeline = TIMELINE * 12;
    driver.endTurn(timeline * 1.2); // audio ran 20% longer than estimated
    expect(driver.rate).toBeGreaterThan(1);
    expect(driver.rate).toBeLessThanOrEqual(1.8);
  });

  test("a short turn barely moves the tempo, a very short one not at all", () => {
    // A turn's audio carries lead-in/trailing silence the transcript doesn't
    // describe; on a one-sentence turn that padding dominates and the measured
    // ratio is inflated (0.96 live, vs 0.875 on 27s turns). Letting it pull the
    // calibration would put the mouth behind again on the next real answer.
    const tiny = new VisemeDriver();
    tiny.seedRate(0.88);
    tiny.enqueue([{ viseme: "aa", duration: 800 }]);
    tiny.endTurn(1600); // 1.6s of audio: below the trust floor -> ignored
    expect(tiny.rate).toBeCloseTo(0.88);

    const shortTurn = new VisemeDriver();
    shortTurn.seedRate(0.88);
    shortTurn.enqueue(seq); // 1.3s estimated
    shortTurn.endTurn(3900); // 3.9s audio => measured 3.0, but low confidence
    const longTurn = new VisemeDriver();
    longTurn.seedRate(0.88);
    longTurn.enqueue(Array.from({ length: 12 }, () => seq).flat());
    longTurn.endTurn(TIMELINE * 12 * 3); // same 3.0 ratio, full confidence
    // Both move up, but the short turn moves far less than the long one.
    expect(shortTurn.rate).toBeGreaterThan(0.88);
    expect(shortTurn.rate - 0.88).toBeLessThan((longTurn.rate - 0.88) / 2);
  });

  test("a higher tempo slows how fast the mouth advances through the text", () => {
    const slow = new VisemeDriver();
    slow.seedRate(1);
    slow.enqueue(seq);
    const stretched = new VisemeDriver();
    stretched.seedRate(1.5); // this voice takes 1.5x the estimated time
    stretched.enqueue(seq);
    // Same heard position: the 1.0 driver has reached the closure, the 1.5 one
    // is still back in the word gap because it must advance more slowly.
    const p = heardFor(600); // 440
    expect(at(slow, p)).toBe("PP");
    expect(at(stretched, p)).toBeNull();
    // It needs proportionally more audio to reach "O".
    expect(at(stretched, heardFor(900, 1.5))).toBe("O");
  });

  test("starts calibrated to Gemini's voice, not at a neutral 1.0", () => {
    // Measured on two real turns: her audio runs ~0.88x the duration table's
    // estimate. Starting at 1.0 makes the mouth advance too slowly and fall
    // progressively behind (~3.8s of lag by the end of a 27s turn), so the
    // default must be below 1. Guards against regressing to a "neutral" seed.
    const driver = new VisemeDriver();
    expect(driver.rate).toBeLessThan(1);
    expect(driver.rate).toBeGreaterThan(0.7);
  });

  test("a faster voice than estimated makes the mouth advance quicker", () => {
    const neutral = new VisemeDriver();
    neutral.seedRate(1);
    neutral.enqueue(seq);
    const calibrated = new VisemeDriver();
    calibrated.seedRate(0.88); // she speaks faster than the table predicts
    calibrated.enqueue(seq);
    // At the same heard position the calibrated driver is further along the text.
    const p = heardFor(560); // neutral lands in the word gap [400,600)
    expect(at(neutral, p)).toBeNull();
    expect(at(calibrated, p)).toBe("PP");
  });

  test("pendingMs reports when the transcript schedule has run dry", () => {
    const driver = new VisemeDriver();
    driver.enqueue(seq);
    at(driver, 0);
    expect(driver.pendingMs).toBeGreaterThan(0);
    at(driver, 100000); // played far past the end of the received text
    expect(driver.pendingMs).toBe(0);
    // More transcript arriving makes it pending again (no permanent handover).
    driver.enqueue([{ viseme: "I", duration: 80 }]);
    expect(driver.pendingMs).toBeGreaterThan(0);
  });

  test("reset drops the queued turn but keeps the learned tempo", () => {
    const driver = new VisemeDriver();
    driver.seedRate(1.3);
    driver.enqueue(seq);
    driver.reset();
    expect(at(driver, heardFor(200))).toBeNull(); // nothing queued
    expect(driver.rate).toBeCloseTo(1.3);
  });
});

describe("VisemeDriver (audio-anchored syllable beats)", () => {
  // "pa-pa": two syllables, each a /p/ closure then a vowel.
  const twoSyllables = [
    { viseme: "PP", duration: 60, vowel: false }, //  [0, 60)
    { viseme: "aa", duration: 200, vowel: true }, //  [60, 260)   nucleus 1
    { viseme: "PP", duration: 60, vowel: false }, //  [260, 320)
    { viseme: "O", duration: 200, vowel: true }, //   [320, 520)  nucleus 2
  ];

  /** Feed frames of a given loudness and collect the emitted visemes. */
  const feed = (
    driver: VisemeDriver,
    frames: number,
    rms: number,
    dt = 16
  ): (string | null)[] => {
    const out: (string | null)[] = [];
    for (let i = 0; i < frames; i++) {
      out.push(driver.tickAnchored({ dt, rms, speaking: true }));
    }
    return out;
  };

  test("a loudness beat advances to the next syllable, not the average clock", () => {
    const driver = new VisemeDriver();
    driver.enqueue(twoSyllables);

    // First beat: quiet, then loud -> jumps to syllable 1, whose onset is /p/.
    feed(driver, 8, 0.01); // quiet valley: arms the detector, not silence
    const first = feed(driver, 1, 1.0)[0];
    expect(first).toBe("PP");
    // Holding the vowel while the sound continues.
    const held = feed(driver, 12, 0.9);
    expect(held[held.length - 1]).toBe("aa");
  });

  test("the vowel is SUSTAINED between beats instead of running ahead", () => {
    const driver = new VisemeDriver();
    driver.enqueue(twoSyllables);
    feed(driver, 8, 0.01); // quiet valley: arms the detector, not silence
    feed(driver, 1, 1.0); // beat 1
    // 40 frames x 16ms = 640ms of continuous sound, far longer than the 200ms
    // the duration table gave the vowel. An averaged clock would have marched on
    // into the next syllable; anchored, the mouth holds the vowel it is hearing.
    const long = feed(driver, 40, 0.9);
    expect(long[long.length - 1]).toBe("aa");
  });

  test("a second beat moves on to the second syllable", () => {
    const driver = new VisemeDriver();
    driver.enqueue(twoSyllables);
    feed(driver, 8, 0.01); // quiet valley: arms the detector, not silence
    feed(driver, 1, 1.0); // beat 1 -> syllable 1
    feed(driver, 10, 0.9); // vowel of syllable 1
    feed(driver, 8, 0.05); // dip: re-arms the detector
    const second = feed(driver, 1, 1.0)[0]; // beat 2
    expect(second).toBe("PP"); // the /p/ that opens syllable 2
    const held = feed(driver, 12, 0.9);
    expect(held[held.length - 1]).toBe("O"); // its vowel
    expect(driver.beatCount).toBe(2);
  });

  test("a sustained pause closes the mouth", () => {
    const driver = new VisemeDriver();
    driver.enqueue(twoSyllables);
    feed(driver, 8, 0.01); // quiet valley: arms the detector, not silence
    feed(driver, 1, 1.0);
    feed(driver, 10, 0.9);
    // Silence for well over SILENCE_HOLD_MS.
    const quiet = feed(driver, 20, 0.0);
    expect(quiet[quiet.length - 1]).toBeNull();
  });

  test("spikes faster than a syllable do not trigger extra beats", () => {
    const driver = new VisemeDriver();
    driver.enqueue(twoSyllables);
    feed(driver, 8, 0.01); // quiet valley: arms the detector, not silence
    // Alternate loud/quiet every frame (16ms) - far faster than any real
    // syllable. The refractory period must reject these.
    for (let i = 0; i < 20; i++) feed(driver, 1, i % 2 ? 1.0 : 0.01);
    // 20 frames x 16ms = 320ms, so the 90ms refractory period allows at most
    // four beats however many spikes there were.
    expect(driver.beatCount).toBeLessThanOrEqual(4);
  });

  test("not speaking eases to rest", () => {
    const driver = new VisemeDriver();
    driver.enqueue(twoSyllables);
    feed(driver, 8, 0.01); // quiet valley: arms the detector, not silence
    feed(driver, 1, 1.0);
    expect(driver.tickAnchored({ dt: 16, rms: 0, speaking: false })).toBeNull();
  });
});

describe("VisemeDriver (beat detection by prominence)", () => {
  const syllables = Array.from({ length: 8 }, (_, i) =>
    i % 2 === 0
      ? { viseme: "PP", duration: 60, vowel: false }
      : { viseme: "aa", duration: 180, vowel: true }
  );

  /**
   * Syllables INSIDE a word: the energy dips between them, but only to 40% of
   * the peak - it never reaches anything like silence. This is the case that
   * broke threshold-based detection, which found only 46 of 87 real syllables
   * because it needed an absolute "off" level to re-arm. Prominence detection
   * must see each loud block as its own beat.
   */
  test("syllables whose valleys never reach silence are still separate beats", () => {
    const driver = new VisemeDriver();
    driver.enqueue(syllables);
    // The silence that always precedes speech, so the first rise has a valley
    // to be prominent against (from a cold start valley == env, by definition).
    for (let f = 0; f < 8; f++) driver.tickAnchored({ dt: 16, rms: 0, speaking: true });
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let f = 0; f < 8; f++) driver.tickAnchored({ dt: 16, rms: 1.0, speaking: true });
      for (let f = 0; f < 8; f++) driver.tickAnchored({ dt: 16, rms: 0.4, speaking: true });
    }
    // One beat per loud block; nothing here ever went quiet enough for a
    // threshold detector to re-arm, so this is exactly the merge case.
    expect(driver.beatCount).toBeGreaterThanOrEqual(4);
  });

  test("a steady tone is not a stream of beats", () => {
    // Constant loudness has no prominence, so after the initial onset there is
    // nothing to detect. Guards against the mouth chattering on sustained vowels.
    const driver = new VisemeDriver();
    driver.enqueue(syllables);
    for (let f = 0; f < 60; f++) driver.tickAnchored({ dt: 16, rms: 0.8, speaking: true });
    expect(driver.beatCount).toBeLessThanOrEqual(2);
  });
});

describe("prosodic beats (what the body runs on)", () => {
  /** Walk the whole timeline at natural pace and collect what it emitted. */
  const play = (driver: VisemeDriver, ms: number) => {
    for (let t = 0; t < ms; t += 16) {
      driver.tick({ dt: 16, speaking: true, naturalPace: true });
    }
    return driver.consumeBeats();
  };

  test("a stressed syllable emits a stress beat", () => {
    const driver = new VisemeDriver();
    driver.enqueue([
      { viseme: "PP", duration: 60 },
      { viseme: "aa", duration: 115, vowel: true, stressed: true },
    ]);
    expect(play(driver, 400).filter((b) => b.kind === "stress")).toHaveLength(1);
  });

  test("a punctuation pause emits a clause beat at full strength", () => {
    const driver = new VisemeDriver();
    driver.enqueue([
      { viseme: "aa", duration: 115, vowel: true },
      { viseme: null, duration: 300 },
      { viseme: "SS", duration: 80 },
    ]);
    const clauses = play(driver, 700).filter((b) => b.kind === "clause");
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.strength).toBe(1);
  });

  test("a word gap is not a clause boundary", () => {
    // Every word break is a rest unit. Gesturing on each one would be a beat
    // every ~300 ms, which is a twitch, not body language.
    const driver = new VisemeDriver();
    driver.enqueue([
      { viseme: "aa", duration: 115, vowel: true },
      { viseme: null, duration: 45 },
      { viseme: "SS", duration: 80 },
    ]);
    expect(play(driver, 500).filter((b) => b.kind === "clause")).toEqual([]);
  });

  test("a beat is delivered exactly once", () => {
    const driver = new VisemeDriver();
    driver.enqueue([
      { viseme: "aa", duration: 115, vowel: true, stressed: true },
      { viseme: null, duration: 300 },
      { viseme: "SS", duration: 80 },
    ]);
    expect(play(driver, 700).length).toBe(2);
    // Keep ticking on the same units: nothing new to report.
    expect(play(driver, 300)).toEqual([]);
  });

  test("a comma is a clause boundary even though the mouth barely pauses", () => {
    // Its rest is a word gap long, so a consumer reading only rest lengths would
    // miss the commonest boundary in speech - and commas are exactly where a
    // speaker's hand beats land.
    const driver = new VisemeDriver();
    driver.enqueue(spanishTextToUnits("Hola, soy Manglara"));
    const clauses = play(driver, 2500).filter((b) => b.kind === "clause");
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.strength).toBeLessThan(1); // weaker than a full stop
  });

  test("the full stop that ends a turn is still reported", () => {
    // It is the last thing in the queue with no shape after it, so a boundary
    // that only fires on the way OUT of the pause would lose it.
    const driver = new VisemeDriver();
    driver.enqueue(spanishTextToUnits("Gracias."));
    expect(play(driver, 2000).filter((b) => b.kind === "clause")).toHaveLength(1);
  });

  test("beats do not survive a reset", () => {
    // A turn boundary drops the schedule; carrying its prosody into the next
    // turn would fire a burst of gestures on the first frame of the new one.
    const driver = new VisemeDriver();
    driver.enqueue([{ viseme: "aa", duration: 115, vowel: true, stressed: true }]);
    for (let t = 0; t < 300; t += 16) {
      driver.tick({ dt: 16, speaking: true, naturalPace: true });
    }
    driver.reset();
    expect(driver.consumeBeats()).toEqual([]);
  });

  test("real Spanish produces beats at a speaking rate", () => {
    const driver = new VisemeDriver();
    const units = spanishTextToUnits("Hola, soy Manglara. Tejemos redes verdes.");
    driver.enqueue(units);
    const beats = play(driver, unitsDuration(units) + 200);
    expect(beats.filter((b) => b.kind === "stress").length).toBeGreaterThanOrEqual(4);
    // Two sentence stops and one comma.
    expect(beats.filter((b) => b.kind === "clause").length).toBeGreaterThanOrEqual(2);
  });
});
