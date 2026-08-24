/**
 * Real-Time Audio-Driven Viseme Engine with Smooth Organic Interpolation.
 *
 * Drives the avatar mouth directly from the WebAudio API AnalyserNode signal.
 * Evaluates real-time RMS volume envelope and spectral formants (FFT) every frame:
 *  - RMS volume < threshold => mouth smoothly eases to closed (REST).
 *  - Low frequency energy => Open/Rounded vowels (/a/, /o/, /u/).
 *  - Mid frequency energy => Spread vowels (/e/, /i/).
 *  - High frequency energy => Sibilants/Fricatives (/s/, /f/, /t/, /d/).
 *
 * Uses continuous viseme weight blending (attack/decay) and exponential shape LERP
 * to eliminate robotic snapping, fluttering, and hard viseme jumps.
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
 * Loudness (as a fraction of the speaker's recent peak) below which the frame is
 * treated as a consonant closure rather than a quiet vowel. Speech is not a
 * continuous vowel: /p/, /b/, /m/, /t/, /k/ are *silences with the mouth shut*,
 * and a classifier that only ever ranks frequency bands has no way to emit one -
 * it keeps picking whichever vowel the residual energy resembles, so the mouth
 * chatters open through every stop. This is what made syllables not line up with
 * what was being said.
 */
const CLOSURE_LOUDNESS = 0.34;
/** Time constant for the running loudness peak the closure test is relative to. */
const PEAK_DECAY_MS = 1200;

export class VisemeDriver {
  private currentViseme: string | null = null;
  private currentShape: LipShape = { ...REST };
  private visemeWeights: Record<string, number> = {};
  private smoothedVolume = 0;
  /** Slow-decaying loudness peak, so the closure test adapts to the speaker. */
  private peakVolume = 0;

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

  /**
   * How hard the current shape should be pushed onto the rig, 0..1.
   *
   * Loudness relative to the speaker's recent peak, not an absolute level, so it
   * survives a quiet mic or a loud one. The controller multiplies the morph
   * weight by this: without it every frame of speech is written at full strength
   * and the avatar bellows every syllable at maximum aperture regardless of
   * whether she is emphasising a word or trailing off.
   */
  get intensity(): number {
    if (this.peakVolume <= 1e-4) return 0;
    return Math.min(1, this.smoothedVolume / this.peakVolume);
  }

  get backlogMs(): number {
    return 0;
  }

  get rate(): number {
    return 1.0;
  }

  get playedMs(): number {
    return 0;
  }

  seedRate(_rate: number): void {
    // No-op in pure audio-driven engine
  }

  enqueue(_units: unknown[], _arrivalFedMs?: number): void {
    // No-op: speech is driven by real-time WebAudio graph
  }

  endTurn(_audioFedMs: number): void {
    // No-op in pure audio-driven engine
  }

  reset(): void {
    this.currentViseme = null;
    this.currentShape = { ...REST };
    this.smoothedVolume = 0;
    this.peakVolume = 0;
    this.resetWeights();
  }

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

    // Track the speaker's recent loudness peak. Decays slowly so a single loud
    // syllable does not flatten everything after it, but fast enough to follow a
    // change of speaking level within a sentence or two.
    this.peakVolume = Math.max(
      this.smoothedVolume,
      this.peakVolume * (1 - Math.min(1, dt / PEAK_DECAY_MS))
    );

    // Silence handling: smooth closure towards REST
    if (this.smoothedVolume < 0.02) {
      this.currentViseme = null;
      const decayAlpha = Math.min(1, dt / 30);
      for (const k of Object.keys(this.visemeWeights)) {
        this.visemeWeights[k] = (this.visemeWeights[k] ?? 0) * (1 - decayAlpha);
      }
      this.visemeWeights["sil"] = 1;

      // Smoothly ease currentShape to REST
      const closeAlpha = Math.min(1, dt / 25);
      this.currentShape = lerpLipShape(this.currentShape, REST, closeAlpha);
      if (this.currentShape.aperture < 0.01) {
        this.currentShape = { ...REST };
      }
      return null;
    }

    // Spectral analysis into Low, Mid, and High formant bands
    let lowEnergy = 0;  // 100 Hz - 800 Hz (/a/, /o/, /u/)
    let midEnergy = 0;  // 800 Hz - 2500 Hz (/e/, /i/)
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

    if (this.intensity < CLOSURE_LOUDNESS) {
      // A dip well below the speaker's own level, with sound still present: a
      // stop or a nasal. Shut the lips.
      selectedViseme = "PP";
    } else if (total > 0.01) {
      // Ratios only. The thresholds these replaced compared a band average
      // against an absolute level (`highEnergy > 0.55`), and a band average of a
      // normalised FFT rarely clears 0.5 - so the /s/ and /o/ branches almost
      // never fired and nearly everything fell through to the wide-open default.
      const highRatio = highEnergy / total;
      const lowRatio = lowEnergy / total;
      const midRatio = midEnergy / total;

      if (highRatio > 0.45) {
        // Sibilant. The more the energy piles into the top band, the closer the
        // teeth: /s/ is a narrow slit, /f/ has the lip tucked under.
        selectedViseme = highRatio > 0.62 ? "SS" : "FF";
      } else if (lowRatio > 0.55) {
        // Rounded back vowel. /u/ is the more extreme pucker of the two.
        selectedViseme = lowRatio > 0.92 ? "U" : "O";
      } else if (midRatio > 0.5) {
        selectedViseme = midRatio > 0.65 ? "I" : "E";
      } else {
        // Energy spread evenly across the bands - that is /a/, an open tract.
        selectedViseme = "aa";
      }
    }

    this.currentViseme = selectedViseme;

    // Smoothly update viseme weights (attack ~60ms, decay ~90ms) to eliminate robotic snapping
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

    // Blend dominant shapes organically using feature table
    const targetShape = blendLipShapes((k) => this.visemeWeights[k] ?? 0);

    // Scale aperture smoothly by RMS volume with an expressive soft-knee curve
    const volumeApertureScale = Math.min(
      1.25,
      0.45 + Math.pow(Math.max(0, this.smoothedVolume * 2.8), 0.6) * 0.75
    );
    const scaledTarget: LipShape = {
      ...targetShape,
      aperture: Math.min(1.1, targetShape.aperture * volumeApertureScale),
    };

    // Smooth LERP to target shape
    const shapeAlpha = Math.min(1, dt / 50);
    this.currentShape = lerpLipShape(this.currentShape, scaledTarget, shapeAlpha);

    return this.currentViseme;
  }

  /** Legacy compatibility wrapper */
  tick(input: {
    dt: number;
    speaking: boolean;
    audioFedMs?: number;
    playedMs?: number;
    /** Dry-run preview: let the clock run free instead of chasing playback. */
    naturalPace?: boolean;
  }): string | null {
    if (!input.speaking) {
      this.reset();
      return null;
    }
    return this.tickFrame({ dt: input.dt, volume: input.speaking ? 0.35 : 0 });
  }
}
