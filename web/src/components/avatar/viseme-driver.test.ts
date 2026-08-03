import { describe, expect, test } from "bun:test";
import { VisemeDriver } from "./viseme-driver";

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

  test("reset clears engine state", () => {
    const driver = new VisemeDriver();
    driver.tickFrame({ dt: 16, volume: 0.8 });
    driver.reset();
    expect(driver.shape).toBeNull();
    expect(driver.currentLipShape.aperture).toBe(0);
  });
});
