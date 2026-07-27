/**
 * Thin wrapper around the Rust engine, plus the render loop that produces the
 * shared stream.
 */

import { CHANNELS, SAMPLE_RATE } from "../shared/protocol";
import { native } from "./ffi";

/** 20 ms per chunk – a good compromise between latency and message rate. */
export const CHUNK_FRAMES = 480;
/**
 * Every audio frame carries its absolute sample position in the header (f64, LE).
 * Without it, a client that joined late could not relate its playback position
 * to the server's timeline – the click and pad feedback would then be off by
 * half a session.
 */
export const CHUNK_HEADER_BYTES = 8;
/** How far ahead of real time the server renders, so clients never run dry. */
const LOOKAHEAD_MS = 160;
/** If the server falls further behind than this, the time base is moved instead of catching up. */
const MAX_CATCHUP_MS = 600;

export class AudioEngine {
  private ptr: ReturnType<typeof native.ge_new>;
  /** Reused FFI buffer: interleaved stereo int16. */
  private readonly scratch: Int16Array<ArrayBuffer> = new Int16Array(CHUNK_FRAMES * CHANNELS);
  private readonly peakBuf = new Float32Array(5);
  private closed = false;
  /** Total frames rendered = the engine's sample position. */
  private position = 0;

  constructor(readonly sampleRate: number = SAMPLE_RATE) {
    this.ptr = native.ge_new(sampleRate);
    if (!this.ptr) throw new Error("ge_new hat einen Nullzeiger geliefert");
  }

  /** Current sample position – the reference point for every scheduled event. */
  get samplePosition(): number {
    return this.position;
  }

  /** Schedules an event at an absolute sample position. */
  schedule(at: number, track: number, kind: number, note: number, vel: number): void {
    if (this.closed) return;
    native.ge_schedule(this.ptr, at, track, kind, note, vel);
  }

  setPatch(track: number, patch: number): void {
    if (!this.closed) native.ge_set_patch(this.ptr, track, patch);
  }

  setGain(track: number, gain: number): void {
    if (!this.closed) native.ge_set_gain(this.ptr, track, gain);
  }

  panic(): void {
    if (!this.closed) native.ge_panic(this.ptr);
  }

  /**
   * Renders exactly one chunk as a ready-to-send frame: 8 bytes of sample
   * position, then interleaved stereo int16.
   */
  renderChunk(): Uint8Array<ArrayBuffer> {
    native.ge_render(this.ptr, this.scratch, CHUNK_FRAMES);

    const frame = new ArrayBuffer(CHUNK_HEADER_BYTES + this.scratch.byteLength);
    new DataView(frame).setFloat64(0, this.position, true);
    new Int16Array(frame, CHUNK_HEADER_BYTES).set(this.scratch);

    this.position += CHUNK_FRAMES;
    return new Uint8Array(frame);
  }

  /** Renders offline into an existing buffer – used by the WAV export. */
  renderInto(target: Int16Array, frames: number): void {
    native.ge_render(this.ptr, target, frames);
    this.position += frames;
  }

  /** Four track levels plus master, each 0..1. */
  peaks(): Float32Array {
    if (this.closed) return this.peakBuf;
    native.ge_peaks(this.ptr, this.peakBuf);
    return this.peakBuf;
  }

  free(): void {
    if (this.closed) return;
    this.closed = true;
    native.ge_free(this.ptr);
  }
}

export interface RenderLoopOptions {
  engine: AudioEngine;
  /** Receives every ready-to-send frame along with the sample position at its end. */
  onChunk(frame: Uint8Array<ArrayBuffer>, endSample: number): void;
}

/**
 * Drives the engine against the wall clock. Deliberately runs a little ahead
 * (`LOOKAHEAD_MS`) so network jitter cannot tear the stream.
 */
export class RenderLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Wall clock instant (ns) corresponding to sample position 0. */
  private originNs = 0;

  constructor(private readonly opts: RenderLoopOptions) {}

  start(): void {
    if (this.timer) return;
    const { engine } = this.opts;
    this.originNs = Bun.nanoseconds() - (engine.samplePosition / engine.sampleRate) * 1e9;
    this.timer = setInterval(() => this.pump(), 5);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private pump(): void {
    const { engine } = this.opts;
    const sr = engine.sampleRate;
    const elapsed = ((Bun.nanoseconds() - this.originNs) / 1e9) * sr;
    let target = elapsed + (LOOKAHEAD_MS / 1000) * sr;

    // After a stall, don't render at fast-forward for minutes: move the time
    // base so the current position counts as "now" again. The engine position
    // itself stays untouched and therefore valid.
    if (target - engine.samplePosition > (MAX_CATCHUP_MS / 1000) * sr) {
      this.originNs = Bun.nanoseconds() - (engine.samplePosition / sr) * 1e9;
      target = engine.samplePosition + (LOOKAHEAD_MS / 1000) * sr;
    }

    while (engine.samplePosition < target) {
      const frame = engine.renderChunk();
      this.opts.onChunk(frame, engine.samplePosition);
    }
  }
}
