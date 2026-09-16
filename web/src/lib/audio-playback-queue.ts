const SAMPLE_RATE = 24000;

function base64ToPcm16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

function pcm16ToFloat32(pcm16: Int16Array): Float32Array {
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 32768;
  }
  return float32;
}

export class AudioPlaybackQueue {
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private _isPlaying = false;

  constructor(private ctx: AudioContext) {}

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  enqueue(base64Pcm: string, onSpeakingChange?: (speaking: boolean) => void): void {
    const pcm16 = base64ToPcm16(base64Pcm);
    if (pcm16.length === 0) return;

    const float32 = pcm16ToFloat32(pcm16);
    const buffer = this.ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.nextStartTime < now) {
      // 120ms safety cushion so consecutive chunks arriving over WebSocket
      // are scheduled ahead of the playhead without dropping to 0 between chunks.
      this.nextStartTime = now + 0.12;
    }

    const wasPlaying = this._isPlaying;
    this._isPlaying = true;
    if (!wasPlaying) onSpeakingChange?.(true);

    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) {
        this._isPlaying = false;
        onSpeakingChange?.(false);
      }
    };
  }

  stop(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
    this._isPlaying = false;
  }
}
