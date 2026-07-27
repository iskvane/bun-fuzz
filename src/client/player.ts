/**
 * Playback of the server mix.
 *
 * The server sends finished stereo PCM chunks; the client synthesizes nothing
 * itself. An AudioWorklet with a ring buffer smooths out network jitter without
 * clicks between chunks.
 *
 * The worklet code below runs on the audio thread and is loaded as a blob – that
 * way everything stays in one file and survives `bun build --compile`.
 */

/** Must match CHUNK_HEADER_BYTES on the server side. */
const HEADER_BYTES = 8;

const WORKLET_SOURCE = /* js */ `
class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.channels = o.channels;
    this.capacity = o.capacity;
    this.ratio = o.ratio;
    this.prebuffer = o.prebuffer;
    this.buf = new Float32Array(this.capacity * this.channels);
    this.written = 0;
    this.readPos = 0;
    this.started = false;
    this.ticks = 0;
    this.port.onmessage = (e) => this.enqueue(e.data);
  }

  enqueue(pcm) {
    const frames = (pcm.length / this.channels) | 0;
    for (let f = 0; f < frames; f++) {
      const dst = ((this.written + f) % this.capacity) * this.channels;
      const src = f * this.channels;
      for (let ch = 0; ch < this.channels; ch++) {
        this.buf[dst + ch] = pcm[src + ch] / 32768;
      }
    }
    this.written += frames;

    // If the client lags too far behind, drop from the front rather than
    // overwriting unread data.
    const backlog = this.written - this.readPos;
    if (backlog > this.capacity * 0.9) {
      this.readPos = this.written - this.capacity * 0.5;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    const outCh = out.length;

    if (!this.started) {
      if (this.written - this.readPos < this.prebuffer) {
        for (let ch = 0; ch < outCh; ch++) out[ch].fill(0);
        return true;
      }
      this.started = true;
    }

    for (let f = 0; f < frames; f++) {
      if (this.readPos + this.ratio + 1 >= this.written) {
        // Underrun: leave the rest silent and re-buffer.
        this.started = false;
        for (let ch = 0; ch < outCh; ch++) out[ch].fill(0, f);
        break;
      }
      const i0 = Math.floor(this.readPos);
      const frac = this.readPos - i0;
      const a = (i0 % this.capacity) * this.channels;
      const b = ((i0 + 1) % this.capacity) * this.channels;
      for (let ch = 0; ch < outCh; ch++) {
        const src = ch < this.channels ? ch : this.channels - 1;
        const s0 = this.buf[a + src];
        const s1 = this.buf[b + src];
        out[ch][f] = s0 + (s1 - s0) * frac;
      }
      this.readPos += this.ratio;
    }

    if ((this.ticks++ & 15) === 0) {
      this.port.postMessage(this.written - this.readPos);
    }
    return true;
  }
}
registerProcessor("pcm-player", PcmPlayer);
`;

export class StreamPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;

  /**
   * Sample position at the end of the most recently received chunk, on the
   * server's timeline. Comes from each frame's header – which is why it is also
   * correct for clients that join in the middle of a running session.
   */
  private streamEnd = 0;
  /** Frames not yet played, as reported by the worklet. */
  private buffered = 0;

  private serverRate = 24_000;
  private channels = 2;

  get running(): boolean {
    return this.ctx?.state === "running";
  }

  /**
   * Approximate playback position in samples, expressed on the server's
   * timeline. It lets the click and pad feedback show exactly when the
   * corresponding sound is actually audible.
   */
  get playbackSample(): number {
    return this.streamEnd - this.buffered;
  }

  /** Must be called from within a user interaction (autoplay rules). */
  async start(serverRate: number, channels: number): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return;
    }
    this.serverRate = serverRate;
    this.channels = channels;

    // Same rate as the server where possible – then no resampling is needed.
    this.ctx = new AudioContext({ sampleRate: serverRate, latencyHint: "interactive" });

    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.node = new AudioWorkletNode(this.ctx, "pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        channels,
        capacity: serverRate * 3,
        // If the browser won't give us the requested rate, we interpolate.
        ratio: serverRate / this.ctx.sampleRate,
        prebuffer: Math.round(serverRate * 0.12),
      },
    });
    this.node.port.onmessage = (e) => {
      this.buffered = e.data as number;
    };

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = 0.9;
    this.node.connect(this.gainNode).connect(this.ctx.destination);

    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Expects one frame: 8 bytes of sample position (f64, LE) + stereo int16. */
  push(frame: ArrayBuffer): void {
    if (frame.byteLength <= HEADER_BYTES) return;
    const startSample = new DataView(frame).getFloat64(0, true);
    const pcm = new Int16Array(frame, HEADER_BYTES);
    this.streamEnd = startSample + pcm.length / this.channels;
    // The buffer is transferred, not copied.
    this.node?.port.postMessage(pcm, [frame]);
  }

  setVolume(v: number): void {
    if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1.5, v));
  }

  /**
   * Delay in ms until playback reaches sample position `at`. Negative values
   * mean it has already gone past.
   */
  delayUntil(at: number): number {
    return ((at - this.playbackSample) / this.serverRate) * 1000;
  }

  async close(): Promise<void> {
    await this.ctx?.close();
    this.ctx = null;
    this.node = null;
  }
}
