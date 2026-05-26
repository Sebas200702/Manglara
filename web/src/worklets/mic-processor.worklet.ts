// Provide minimal ambient declarations for the Worklet environment so
// TypeScript won't error about missing DOM types when compiling in Node
// or strict TS setups.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processorCtor: any): void;
// sampleRate is a global property in AudioWorkletGlobalScope
declare const sampleRate: number;

const TARGET_RATE = 16000;
const FRAME_SAMPLES = Math.floor((TARGET_RATE * 30) / 1000);

class MicProcessor extends AudioWorkletProcessor {
  readonly resampled: number[] = [];
  private accumulator = 0;

  process(inputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;

    const ratio = TARGET_RATE / sampleRate;

    for (let i = 0; i < input.length; i++) {
      this.accumulator += ratio;
      if (this.accumulator >= 1) {
        this.accumulator -= 1;
        const s = Math.max(-1, Math.min(1, input[i]));
        this.resampled.push(s);
      }
    }

    while (this.resampled.length >= FRAME_SAMPLES) {
      const frame = this.resampled.splice(0, FRAME_SAMPLES);
      const pcm16 = new Int16Array(frame.length);
      for (let j = 0; j < frame.length; j++) {
        pcm16[j] = frame[j] < 0 ? frame[j] * 0x8000 : frame[j] * 0x7fff;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
