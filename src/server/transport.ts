/**
 * The shared clock. The single source of truth for timing – clients have no
 * clock of their own that could drift apart.
 *
 * Everything is computed in beats rather than samples, which keeps the grid
 * continuous across a BPM change instead of jumping.
 */

import { SAMPLE_RATE } from "../shared/protocol";

export const BEATS_PER_BAR = 4;

export interface Quantized {
  /** Absolute sample position the event is placed at. */
  sample: number;
  /** The matching beat position, in the form it gets recorded. */
  beat: number;
}

export class Transport {
  bpm = 100;
  /** Denominator of the grid: 16 = sixteenth notes. */
  grid = 16;
  playing = true;

  /** Anchor, so a BPM change doesn't wrench the running beat count. */
  private anchorSample = 0;
  private anchorBeat = 0;

  constructor(readonly sampleRate: number = SAMPLE_RATE) {}

  get samplesPerBeat(): number {
    return (60 / this.bpm) * this.sampleRate;
  }

  /** Changes BPM from `atSample` on, without shifting the beat position so far. */
  setBpm(bpm: number, atSample: number): void {
    const clamped = Math.min(240, Math.max(40, bpm));
    this.anchorBeat = this.beatAt(atSample);
    this.anchorSample = atSample;
    this.bpm = clamped;
  }

  beatAt(sample: number): number {
    return this.anchorBeat + (sample - this.anchorSample) / this.samplesPerBeat;
  }

  sampleAtBeat(beat: number): number {
    return this.anchorSample + (beat - this.anchorBeat) * this.samplesPerBeat;
  }

  /** Beats per grid step: grid 16 → 0.25 beats. */
  get stepBeats(): number {
    return BEATS_PER_BAR / this.grid;
  }

  /**
   * Next grid position at or after `earliestSample`. Because the server renders
   * ahead of real time, `earliestSample` is already the first position not yet
   * in the stream – which is why this always rounds up, never to nearest.
   */
  quantize(earliestSample: number): Quantized {
    const step = this.stepBeats;
    const beat = this.beatAt(earliestSample);
    // Tiny bias so an exactly hit grid line isn't accidentally pushed one step
    // further out.
    const steps = Math.ceil(beat / step - 1e-9);
    const qBeat = steps * step;
    return { sample: this.sampleAtBeat(qBeat), beat: qBeat };
  }

  /** Bar and beat at a sample position, for the click display. */
  barBeatAt(sample: number): { bar: number; beat: number } {
    const beats = Math.floor(this.beatAt(sample));
    return {
      bar: Math.floor(beats / BEATS_PER_BAR),
      beat: ((beats % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR,
    };
  }
}
