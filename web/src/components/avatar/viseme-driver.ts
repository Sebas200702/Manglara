/**
 * Viseme driver for the avatar mouth.
 *
 * PRIMARY PATH - transcript-scheduled (see tick / enqueue). Gemini gives us the
 * assistant's transcript but no phoneme timings, and Spanish orthography maps to
 * phonemes reliably (lipsync-es.ts), so the accurate mouth shapes come from the
 * TEXT. Each enqueued fragment is laid on a cumulative "speech-time" line; every
 * frame we ask where the EAR is (the measured audio playback position, playedMs)
 * and show the viseme scheduled at that point. Because the cursor is read from
 * the measured playback clock rather than integrated from frame deltas, it cannot
 * drift or accumulate dropped-frame error - it re-anchors on every worklet report.
 *
 * The only unknown is tempo: the duration table is an estimate, so `rate` (real
 * audio-ms per estimated speech-ms) is learned at the end of each turn and
 * persisted across sessions. It is ~1 for conversational Spanish.
 *
 * FALLBACK PATH - audio-driven FFT (tickFrame). Kept for when no transcript is
 * available at all (transcription disabled): a coarse spectral-band classifier
 * that only ever approximates vowels. It is strictly worse than the text path and
 * is not used while a transcript is flowing.
 */

import { LIP_SHAPES, REST, lerpLipShape, blendLipShapes, type LipShape } from "./lip-shapes";

export interface AudioFrameInput {
  dt: number;
  /** Frequency data (0..255) from AnalyserNode.getByteFrequencyData */
  frequencyData?: Uint8Array;
  /** Time domain data (0..255) from AnalyserNode.getByteTimeDomainData */
  timeDomainData?: Uint8Array;
  /** Fallback volume level [0..1] when AnalyserNode is unavailable */
  volume?: number;
}

/**
 * A prosodic event the playback cursor has just crossed.
 *
 * The mouth is not the only thing speech drives: a speaker's beat gestures land
 * at clause boundaries and their head/brow accents on stressed syllables. Those
 * moments are already known here - the schedule says where every syllable and
 * every pause sits, and the cursor says which one the ear is at - so the body
 * can run off the same clock as the mouth instead of a timer of its own. See
 * `motion-director`.
 */
export interface Beat {
  kind: "stress" | "clause";
  /** 0..1. For a clause, how long the pause was; a stress is always full. */
  strength: number;
}

/** Rest long enough to count as a clause boundary rather than a word gap. */
const CLAUSE_MIN_REST_MS = 120;
/** Rest at which a boundary is as strong as it gets (a full sentence stop). */
const CLAUSE_FULL_REST_MS = 300;
/** Ceiling on undelivered beats, so a hidden tab cannot grow the list forever. */
const MAX_PENDING_BEATS = 32;

/** One scheduled mouth shape, placed on the cumulative speech-time line (ms). */
interface ScheduledUnit {
  viseme: string | null;
  start: number;
  end: number;
  /** Syllable nucleus: the unit the audio can actually be aligned to. */
  vowel: boolean;
  /** Stressed syllable of its word (see lipsync-es). Prosody, not articulation. */
  stressed: boolean;
  /** On a rest: punctuation strength, 0 for a plain word break. */
  boundary: number;
}

/** A syllable nucleus plus the consonant run that leads into it. */
interface Nucleus {
  /** Speech time where the syllable's leading consonants begin. */
  onsetStart: number;
  /** Speech-time span of the vowel itself. */
  start: number;
  end: number;
}

/** Learned tempo bounds (real audio-ms per estimated speech-ms). ~1 is neutral. */
const RATE_MIN = 0.55;
const RATE_MAX = 1.8;
/**
 * Starting tempo, MEASURED against Gemini's Spanish voice on a real 24 s turn
 * (2026-09-02): the audio ran 0.88x the duration table's estimate, i.e. she
 * speaks noticeably faster than the per-phoneme averages in lipsync-es.ts.
 *
 * This is not cosmetic. Starting from a neutral 1.0 makes the mouth advance ~14%
 * too slowly through the text, so it falls PROGRESSIVELY BEHIND the voice - about
 * 3.3 s of accumulated lag by the end of a 24 s turn, which is precisely the
 * "los gestos tardan más que la pronunciación" report. Starting calibrated means
 * even the first turn of a fresh session is close.
 */
const DEFAULT_RATE = 0.88;
/**
 * How much a turn's measured tempo pulls the running estimate. Deliberately
 * FAST: the end-of-turn measurement is exact rather than noisy (complete
 * transcript vs complete audio), so heavy smoothing buys nothing and only delays
 * convergence - at 0.3-0.4 it takes about five turns to catch a voice whose pace
 * differs this much, and every turn until then is visibly out of step.
 */
const RATE_LEARN = 0.6;
/** Turns shorter than this carry too much silence padding to calibrate from. */
const RATE_MIN_TURN_MS = 2500;
/** Turn length at which the end-of-turn measurement is trusted in full. */
const RATE_FULL_TRUST_MS = 10000;
/**
 * How far the mouth runs AHEAD of the measured ear position, ms.
 *
 * Three reasons, all making the mouth read as "on the beat" rather than trailing:
 *  - In real speech the articulators MOVE BEFORE the sound comes out (the lips
 *    close for /p/ while the /p/ is still silent), so a mouth aligned exactly to
 *    the acoustic onset is perceptually late.
 *  - Everything after this function adds delay: morph writes, the 30 fps render
 *    frame, and the display itself.
 *  - The residual tempo error still accumulates within a turn (~174 ms by the
 *    end of a 27 s turn, see DEFAULT_RATE), always in the "mouth behind"
 *    direction, so a constant lead absorbs the bulk of it.
 *
 * This is the main lever for "los gestos tardan más que la pronunciación", and
 * the one to turn on user feedback. Raised 90 -> 160 on 2026-09-02 after the
 * user still read it as slightly behind in a real call. Perception is very
 * asymmetric here: mouth AHEAD of voice stays comfortable out to ~200 ms, while
 * mouth behind is objectionable within ~100 ms - so err on this side.
 */
export const MOUTH_LEAD_MS = 160;
/**
 * Shape ease time constant for currentLipShape (visual only; ms). Short, so
 * consonants still land as distinct shapes instead of being smeared into the
 * neighbouring vowels - a long ease is what makes the mouth look sluggish.
 */
const SHAPE_EASE_MS = 42;

// --- audio-anchored alignment ---------------------------------------------
// An averaged tempo places every syllable where the AVERAGE says, not where it
// is actually spoken, so even a perfectly calibrated rate cannot read as real
// lip-sync ("un promedio no da la sensación de lips sync"). Speech energy peaks
// once per syllable, so the audio itself carries the beat: the transcript
// supplies WHICH shapes (phonetically correct), and these detect WHEN.
/** Envelope follower: fast attack so a syllable onset is not smeared away. */
const ENV_ATTACK_MS = 8;
const ENV_RELEASE_MS = 30;
/** Slow-decaying peak, so thresholds adapt to the voice's own loudness. */
const ENV_PEAK_DECAY_MS = 1500;
/**
 * Absolute floor for the peak used to normalise the envelope. Without it, a
 * steady quiet signal normalises against ITSELF (peak == env, so rel == 1) and
 * reads as full-scale, firing beats on near-silence and room tone. Real speech
 * peaks well above this, so it only ever binds during quiet passages.
 */
const ENV_ABS_FLOOR = 0.05;
/** Envelope below which it is silence no matter what the peak says. */
const ENV_SILENCE_ABS = 0.008;
/** Envelope, relative to the running peak, below which this is a pause. */
const SILENCE_REL = 0.12;
/** How long that must hold before the mouth closes (avoids stop-consonant dips). */
const SILENCE_HOLD_MS = 120;
/**
 * A syllable beat is detected by PROMINENCE: the envelope rising this many times
 * above the lowest point since the previous beat.
 *
 * Not by crossing a fixed threshold. Measured against her real voice, threshold
 * crossing found only 46 of 87 syllables (2.5/s where Spanish runs ~4.8/s),
 * because inside a word the energy dips only to ~50-70% of the peak and never
 * reaches an absolute "off" level - so adjacent syllables merged into one beat.
 * Prominence catches those: validated on two real turns at 87/87 and 189/188
 * syllables. Do not "simplify" this back to a threshold.
 */
const BEAT_RISE_FACTOR = 1.9;
/** Envelope below which no beat fires, however prominent the rise. */
const BEAT_FLOOR = 0.012;
/** Floor on the valley, so the very first rise from digital silence can fire. */
const BEAT_VALLEY_FLOOR = 0.004;
/** Envelope, relative to peak, above which sound counts as present (voiced). */
const VOICED_REL = 0.2;
/** Refractory period: no syllable is shorter than this, so ignore faster spikes. */
const SYLLABLE_MIN_MS = 115;
/**
 * How far the audio-anchored cursor may wander from the averaged-clock position.
 * The beat detector gives excellent LOCAL alignment but can gain or lose whole
 * syllables over a long turn (a missed onset, or an energy dip inside one word);
 * the averaged clock is globally reliable but locally wrong. Clamping to a window
 * around it keeps the local beat while bounding the global error.
 */
const ANCHOR_DRIFT_TOL_MS = 220;

export class VisemeDriver {
  private currentViseme: string | null = null;
  private currentShape: LipShape = { ...REST };

  // --- transcript scheduling ------------------------------------------------
  /** Scheduled units for the current turn, in order, covering [0, timelineMs). */
  private queue: ScheduledUnit[] = [];
  /** End of the last enqueued unit: the total estimated speech so far, ms. */
  private timelineMs = 0;
  /** Last speech position emitted, ms. Monotonic within a turn. */
  private cursorMs = 0;
  /** Dry-run cursor (window.__say): advances by wall time, no audio. */
  private naturalMs = 0;
  /** Cached queue index for the current cursor, so lookup is ~O(1) per frame. */
  private headIndex = 0;
  /** Learned tempo: real audio-ms per estimated speech-ms. */
  private _rate = DEFAULT_RATE;

  // --- audio-anchored alignment state --------------------------------------
  /** Syllable nuclei in the queue, in order. */
  private nuclei: Nucleus[] = [];
  /** Envelope follower and its running peak. */
  private env = 0;
  private envPeak = 0;
  /** Lowest envelope seen since the last beat: the prominence reference. */
  private valley = Number.POSITIVE_INFINITY;
  private sinceOnsetMs = SYLLABLE_MIN_MS;
  private silenceMs = 0;
  /** Diagnostics: how many syllable beats were detected this turn. */
  private beats = 0;

  // --- prosody output -------------------------------------------------------
  /** Beats crossed but not yet handed to the caller. */
  private pendingBeats: Beat[] = [];
  /** Last queue index whose beat was emitted, so nothing fires twice. */
  private beatCursor = -1;
  /** Rest crossed since the last shape, ms: what makes a clause boundary. */
  private restRunMs = 0;
  /** Whether the current run of rests has already reported its boundary. */
  private restBeatSent = false;

  // --- FFT fallback state ---------------------------------------------------
  private visemeWeights: Record<string, number> = {};
  private smoothedVolume = 0;

  constructor() {
    this.resetWeights();
  }

  private resetWeights(): void {
    for (const key of Object.keys(LIP_SHAPES)) {
      this.visemeWeights[key] = 0;
    }
    this.visemeWeights["sil"] = 1;
  }

  get shape(): string | null {
    return this.currentViseme;
  }

  get currentLipShape(): LipShape {
    return this.currentShape;
  }

  /** Remaining un-played speech, ms. Used by the dry-run to know when it's done. */
  get backlogMs(): number {
    return Math.max(0, this.timelineMs - this.naturalMs);
  }

  /**
   * Scheduled speech still ahead of the live play cursor, ms. Zero means the
   * transcript has been fully consumed - if audio is still playing the caller
   * should hand the mouth to the audio fallback until more transcript arrives.
   */
  get pendingMs(): number {
    return Math.max(0, this.timelineMs - this.cursorMs);
  }

  /** Learned tempo (real audio-ms per estimated speech-ms). */
  get rate(): number {
    return this._rate;
  }

  get playedMs(): number {
    return this.cursorMs;
  }

  /** Seed the tempo from a value learned in an earlier session. */
  seedRate(rate: number): void {
    if (Number.isFinite(rate) && rate > 0) {
      this._rate = Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
    }
  }

  /**
   * Append a transcript fragment's shapes to the turn's timeline. `arrivalFedMs`
   * (audio delivered when this fragment arrived) is accepted for API symmetry but
   * not needed: the fragments are contiguous, so their cumulative durations ARE
   * the timeline, and playback position - not arrival time - places the cursor.
   */
  enqueue(
    units: {
      viseme: string | null;
      duration: number;
      vowel?: boolean;
      stressed?: boolean;
      boundary?: number;
    }[],
    _arrivalFedMs?: number
  ): void {
    for (const u of units) {
      if (u.duration <= 0) continue;
      const unit: ScheduledUnit = {
        viseme: u.viseme,
        start: this.timelineMs,
        end: this.timelineMs + u.duration,
        vowel: u.vowel === true && u.viseme !== null,
        stressed: u.stressed === true && u.viseme !== null,
        boundary: u.viseme === null ? u.boundary ?? 0 : 0,
      };
      this.queue.push(unit);
      this.timelineMs = unit.end;

      if (unit.vowel) {
        // Index it together with the consonant run that leads into it, so an
        // audio beat can jump the mouth to the START of the syllable (the /p/ of
        // "pa"), not just to the vowel. Walk back over consonants only - a rest
        // ends the syllable, and so does another vowel.
        let onsetStart = unit.start;
        for (let i = this.queue.length - 2; i >= 0; i--) {
          const prev = this.queue[i]!;
          if (prev.viseme === null || prev.vowel) break;
          onsetStart = prev.start;
        }
        this.nuclei.push({ onsetStart, start: unit.start, end: unit.end });
      }
    }
  }

  /**
   * End of turn: the transcript is complete and `audioFedMs` is the true spoken
   * length, so their ratio is the exact tempo. Fold it into the running estimate.
   *
   * Weighted by how much evidence the turn carries. A turn's audio includes lead-in
   * and trailing silence that the transcript does not describe, and on a short turn
   * that padding dominates: measured live, a one-sentence turn read 0.96 where 27 s
   * turns read 0.875-0.880. Letting a short turn move the tempo as much as a long
   * one drags the calibration up and the mouth falls behind again on the next real
   * answer, so short turns are down-weighted and very short ones ignored.
   */
  endTurn(audioFedMs: number): void {
    if (this.timelineMs <= 100 || audioFedMs < RATE_MIN_TURN_MS) return;
    const measured = Math.min(RATE_MAX, Math.max(RATE_MIN, audioFedMs / this.timelineMs));
    const confidence = Math.min(1, audioFedMs / RATE_FULL_TRUST_MS);
    const alpha = RATE_LEARN * confidence;
    this._rate = Math.min(
      RATE_MAX,
      Math.max(RATE_MIN, this._rate * (1 - alpha) + measured * alpha)
    );
  }

  reset(): void {
    this.queue = [];
    this.nuclei = [];
    this.timelineMs = 0;
    this.cursorMs = 0;
    this.naturalMs = 0;
    this.headIndex = 0;
    this.env = 0;
    this.envPeak = 0;
    this.valley = Number.POSITIVE_INFINITY;
    this.sinceOnsetMs = SYLLABLE_MIN_MS;
    this.silenceMs = 0;
    this.beats = 0;
    this.pendingBeats = [];
    this.beatCursor = -1;
    this.restRunMs = 0;
    this.restBeatSent = false;
    this.currentViseme = null;
    this.currentShape = { ...REST };
    this.smoothedVolume = 0;
    this.resetWeights();
    // _rate is intentionally kept: tempo carries across turns and sessions.
  }

  /**
   * Advance the mouth one frame from the transcript schedule.
   *
   *  - naturalPace (dry-run): advance by wall time, no audio clock.
   *  - speaking with a measured playback position: map the ear's position to the
   *    speech timeline via the learned tempo and show the viseme scheduled there.
   *  - speaking without metrics yet: creep forward by frame time so the mouth
   *    still moves; it re-anchors the instant a playback report lands.
   *  - not speaking: ease to rest.
   */
  tick(input: {
    dt: number;
    speaking: boolean;
    audioFedMs?: number;
    playedMs?: number;
    naturalPace?: boolean;
  }): string | null {
    const { dt, speaking, playedMs, naturalPace } = input;

    if (naturalPace) {
      this.naturalMs += dt;
      return this.emitAt(this.naturalMs, dt);
    }

    if (!speaking) {
      this.currentViseme = null;
      this.currentShape = lerpLipShape(this.currentShape, REST, Math.min(1, dt / 25));
      if (this.currentShape.aperture < 0.01) this.currentShape = { ...REST };
      return null;
    }

    let pos: number;
    if (playedMs !== undefined && this.timelineMs > 0 && this._rate > 0) {
      // Where the EAR is, expressed on the speech-time line, plus the lead that
      // keeps the mouth from reading as late (see MOUTH_LEAD_MS).
      pos = (playedMs + MOUTH_LEAD_MS) / this._rate;
    } else {
      // No measured clock yet: creep forward so the mouth isn't frozen. Snaps
      // back onto the true position as soon as metrics arrive.
      pos = this.cursorMs + dt;
    }
    // Monotonic, and never run past what has actually been enqueued.
    pos = Math.min(Math.max(pos, this.cursorMs), this.timelineMs);
    this.cursorMs = pos;
    return this.emitAt(pos, dt);
  }

  /**
   * Advance the mouth one frame with the SYLLABLES PINNED TO THE AUDIO.
   *
   * The transcript decides which shapes; the audio's own energy peaks decide when
   * each one happens. On every detected syllable beat the mouth jumps to the
   * start of the next syllable (its leading consonants included), plays through
   * them at natural pace, then HOLDS the vowel until the next beat - so a long
   * syllable stays open and a fast one is cut short, matching what is actually
   * heard rather than what the duration averages predicted.
   *
   * `playedMs` (the measured ear position) is still used, but only as a leash:
   * see ANCHOR_DRIFT_TOL_MS.
   */
  tickAnchored(input: {
    dt: number;
    rms: number;
    speaking: boolean;
    playedMs?: number;
  }): string | null {
    const { dt, rms, speaking, playedMs } = input;

    if (!speaking) {
      this.valley = Number.POSITIVE_INFINITY;
      this.silenceMs = 0;
      this.env = 0;
      return this.tick({ dt, speaking: false });
    }

    // Envelope follower: fast attack, slower release.
    const a = Math.min(1, dt / (rms > this.env ? ENV_ATTACK_MS : ENV_RELEASE_MS));
    this.env += (rms - this.env) * a;
    // Running peak so the thresholds below are relative to this voice.
    this.envPeak = Math.max(this.env, this.envPeak * (1 - Math.min(1, dt / ENV_PEAK_DECAY_MS)));
    const rel = this.env / Math.max(this.envPeak, ENV_ABS_FLOOR);

    // A real pause: close the mouth and let the next syllable re-trigger.
    if (rel < SILENCE_REL || this.env < ENV_SILENCE_ABS) {
      this.silenceMs += dt;
      if (this.silenceMs >= SILENCE_HOLD_MS) {
        this.valley = this.env;
        this.currentViseme = null;
        this.currentShape = lerpLipShape(this.currentShape, REST, Math.min(1, dt / SHAPE_EASE_MS));
        return null;
      }
    } else {
      this.silenceMs = 0;
    }

    // Syllable beat detection by prominence (see BEAT_RISE_FACTOR), plus a
    // refractory period so nothing shorter than a syllable can trigger.
    if (this.env < this.valley) this.valley = this.env;
    this.sinceOnsetMs += dt;
    const beat =
      this.env > BEAT_FLOOR &&
      this.sinceOnsetMs >= SYLLABLE_MIN_MS &&
      this.env > Math.max(this.valley, BEAT_VALLEY_FLOOR) * BEAT_RISE_FACTOR;

    if (beat) {
      this.valley = this.env;
      this.sinceOnsetMs = 0;
      this.beats++;
      const next = this.nucleusAfter(this.cursorMs);
      if (next) this.cursorMs = next.onsetStart;
      else this.cursorMs += dt; // out of transcript: keep creeping, don't stall
    } else if (rel >= VOICED_REL) {
      // Sound is present: run through the syllable's consonants at natural pace,
      // then stop at the vowel and hold it until the next beat arrives.
      // Gated on the envelope so the mouth does NOT creep forward through the
      // quiet valleys between syllables - those valleys ARE the closures, and
      // advancing through them is what desynchronises the following syllable.
      const hold = this.holdLimit(this.cursorMs);
      this.cursorMs = hold === null ? this.cursorMs + dt : Math.min(this.cursorMs + dt, hold);
    }

    // Leash to the averaged clock so a missed or spurious beat cannot accumulate.
    if (playedMs !== undefined && this.timelineMs > 0 && this._rate > 0) {
      const expected = (playedMs + MOUTH_LEAD_MS) / this._rate;
      this.cursorMs = Math.min(
        Math.max(this.cursorMs, expected - ANCHOR_DRIFT_TOL_MS),
        expected + ANCHOR_DRIFT_TOL_MS
      );
    }
    this.cursorMs = Math.min(Math.max(this.cursorMs, 0), this.timelineMs);
    return this.emitAt(this.cursorMs, dt);
  }

  /** First syllable nucleus strictly after `pos` (the next beat's target). */
  private nucleusAfter(pos: number): Nucleus | null {
    for (const n of this.nuclei) if (n.start > pos) return n;
    return null;
  }

  /**
   * How far the cursor may advance without a beat: the end of the nucleus at or
   * after it, so the vowel is sustained instead of running on into the next
   * syllable. Null when there is no nucleus ahead (nothing to hold at).
   */
  private holdLimit(pos: number): number | null {
    for (const n of this.nuclei) if (n.end > pos) return n.end - 1;
    return null;
  }

  /** Syllable beats detected in the current turn (diagnostics). */
  get beatCount(): number {
    return this.beats;
  }

  /**
   * Prosodic events crossed since the last call, and clear them.
   *
   * Pull rather than push so the body is driven from the same frame as the
   * mouth: the caller reads these right after ticking the mouth, which is what
   * puts a hand beat on the clause the ear is hearing.
   */
  consumeBeats(): Beat[] {
    if (!this.pendingBeats.length) return [];
    const out = this.pendingBeats;
    this.pendingBeats = [];
    return out;
  }

  /**
   * Emit the prosody of every unit the cursor has passed since the last frame.
   *
   * Beats fire on the way *out* of a rest and *into* a shape, so a clause
   * boundary is reported once its pause is over and its length is known - which
   * is also the moment a speaker's next gesture actually starts.
   *
   * The cursor can jump (the audio-anchored path snaps it to a syllable onset)
   * and it can be pulled backwards by the leash, so this walks indices rather
   * than trusting a single step, and never goes back: a unit whose beat has
   * already fired must not fire again when the cursor revisits it.
   */
  private advanceBeats(toIndex: number): void {
    for (let i = this.beatCursor + 1; i <= toIndex; i++) {
      const u = this.queue[i];
      if (!u) break;
      this.beatCursor = i;
      if (u.viseme === null) {
        this.restRunMs += u.end - u.start;
        // A punctuation mark reports itself the moment the cursor reaches it -
        // its strength is already known, and waiting for the following shape
        // would lose the boundary at the very end of a turn, which is where the
        // biggest one usually is.
        if (u.boundary > 0 && !this.restBeatSent) {
          this.restBeatSent = true;
          this.pendingBeats.push({ kind: "clause", strength: u.boundary });
        }
        continue;
      }
      // No punctuation, but a rest long enough to be a boundary anyway (a
      // hesitation, or units from a source that carries no punctuation).
      if (!this.restBeatSent && this.restRunMs >= CLAUSE_MIN_REST_MS) {
        this.pendingBeats.push({
          kind: "clause",
          strength: Math.min(1, this.restRunMs / CLAUSE_FULL_REST_MS),
        });
      }
      this.restRunMs = 0;
      this.restBeatSent = false;
      if (u.stressed) this.pendingBeats.push({ kind: "stress", strength: 1 });
    }
    if (this.pendingBeats.length > MAX_PENDING_BEATS) {
      this.pendingBeats.splice(0, this.pendingBeats.length - MAX_PENDING_BEATS);
    }
  }

  /** Resolve the scheduled viseme at a speech-time position and ease the shape. */
  private emitAt(pos: number, dt: number): string | null {
    const unit = this.unitAt(pos);
    this.advanceBeats(this.headIndex);
    const viseme = unit ? unit.viseme : null;
    this.currentViseme = viseme;
    const target = viseme ? LIP_SHAPES[viseme] ?? REST : REST;
    this.currentShape = lerpLipShape(this.currentShape, target, Math.min(1, dt / SHAPE_EASE_MS));
    return viseme;
  }

  /** The queue unit covering `pos`, using a forward/backward cached cursor. */
  private unitAt(pos: number): ScheduledUnit | null {
    const q = this.queue;
    if (!q.length) return null;
    let i = Math.min(this.headIndex, q.length - 1);
    while (i > 0 && pos < q[i]!.start) i--;
    while (i < q.length - 1 && pos >= q[i]!.end) i++;
    this.headIndex = i;
    return q[i]!;
  }

  // ==========================================================================
  // FALLBACK: audio-driven FFT. Only used when no transcript is available.
  // ==========================================================================

  /**
   * Process one audio frame. Returns the active Oculus Viseme ID, or null if silent.
   */
  tickFrame(input: AudioFrameInput): string | null {
    const { dt, frequencyData, timeDomainData, volume } = input;

    let rms = 0;
    if (timeDomainData && timeDomainData.length > 0) {
      let sum = 0;
      for (let i = 0; i < timeDomainData.length; i++) {
        const v = (timeDomainData[i]! - 128) / 128;
        sum += v * v;
      }
      rms = Math.sqrt(sum / timeDomainData.length);
    } else if (volume !== undefined) {
      rms = volume;
    } else if (frequencyData && frequencyData.length > 0) {
      let sum = 0;
      for (let i = 0; i < frequencyData.length; i++) {
        const v = frequencyData[i]! / 255;
        sum += v * v;
      }
      rms = Math.sqrt(sum / frequencyData.length);
    }

    // Smooth volume to eliminate high-frequency micro-jitter (~45ms time constant)
    if (rms < 0.005) {
      this.smoothedVolume = 0;
    } else {
      const volAlpha = Math.min(1, dt / 45);
      this.smoothedVolume = this.smoothedVolume * (1 - volAlpha) + rms * volAlpha;
    }

    // Silence handling: smooth closure towards REST
    if (this.smoothedVolume < 0.02) {
      this.currentViseme = null;
      const decayAlpha = Math.min(1, dt / 30);
      for (const k of Object.keys(this.visemeWeights)) {
        this.visemeWeights[k] = (this.visemeWeights[k] ?? 0) * (1 - decayAlpha);
      }
      this.visemeWeights["sil"] = 1;

      const closeAlpha = Math.min(1, dt / 25);
      this.currentShape = lerpLipShape(this.currentShape, REST, closeAlpha);
      if (this.currentShape.aperture < 0.01) {
        this.currentShape = { ...REST };
      }
      return null;
    }

    // Spectral analysis into Low, Mid, and High formant bands
    let lowEnergy = 0; // 100 Hz - 800 Hz (/a/, /o/, /u/)
    let midEnergy = 0; // 800 Hz - 2500 Hz (/e/, /i/)
    let highEnergy = 0; // 2500 Hz - 8000 Hz (/s/, /f/, /t/, /d/)

    if (frequencyData && frequencyData.length >= 16) {
      const len = frequencyData.length;
      const lowEnd = Math.max(1, Math.floor(len * 0.12));
      const midEnd = Math.max(lowEnd + 1, Math.floor(len * 0.38));

      for (let i = 0; i < lowEnd; i++) lowEnergy += frequencyData[i]! / 255;
      for (let i = lowEnd; i < midEnd; i++) midEnergy += frequencyData[i]! / 255;
      for (let i = midEnd; i < len; i++) highEnergy += frequencyData[i]! / 255;

      lowEnergy /= Math.max(1, lowEnd);
      midEnergy /= Math.max(1, midEnd - lowEnd);
      highEnergy /= Math.max(1, len - midEnd);
    } else {
      lowEnergy = this.smoothedVolume;
      midEnergy = this.smoothedVolume * 0.7;
      highEnergy = this.smoothedVolume * 0.3;
    }

    const total = lowEnergy + midEnergy + highEnergy;
    let selectedViseme = "aa";

    if (total > 0.01) {
      const highRatio = highEnergy / total;
      const lowRatio = lowEnergy / total;

      if (highRatio > 0.42) {
        selectedViseme = highEnergy > 0.55 ? "SS" : "FF";
      } else if (lowRatio > 0.48) {
        selectedViseme = lowEnergy > 0.5 ? "O" : "U";
      } else if (midEnergy > lowEnergy) {
        selectedViseme = midEnergy > 0.5 ? "I" : "E";
      } else {
        selectedViseme = "aa";
      }
    }

    this.currentViseme = selectedViseme;

    const attackAlpha = Math.min(1, dt / 60);
    const decayAlpha = Math.min(1, dt / 90);

    for (const k of Object.keys(LIP_SHAPES)) {
      if (k === "sil") continue;
      const targetWeight = k === selectedViseme ? 0.85 : 0;
      const current = this.visemeWeights[k] ?? 0;
      if (targetWeight > current) {
        this.visemeWeights[k] = current + (targetWeight - current) * attackAlpha;
      } else {
        this.visemeWeights[k] = current * (1 - decayAlpha);
      }
    }

    const targetShape = blendLipShapes((k) => this.visemeWeights[k] ?? 0);
    const volumeApertureScale = Math.min(1.15, Math.pow(Math.max(0, this.smoothedVolume * 3.2), 0.75));
    const scaledTarget: LipShape = {
      ...targetShape,
      aperture: Math.min(1, targetShape.aperture * volumeApertureScale),
    };

    const shapeAlpha = Math.min(1, dt / 50);
    this.currentShape = lerpLipShape(this.currentShape, scaledTarget, shapeAlpha);

    return this.currentViseme;
  }
}
