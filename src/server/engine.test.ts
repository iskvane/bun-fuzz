import { describe, expect, test } from "bun:test";
import { SAMPLE_RATE, TRACK_OF } from "../shared/protocol";
import { AudioEngine, CHUNK_FRAMES } from "./audio";
import { encodeWav } from "./export";
import { KIND_NOTE_OFF, KIND_NOTE_ON } from "./ffi";
import { Transport } from "./transport";

function peakOf(pcm: Int16Array): number {
  let peak = 0;
  for (const s of pcm) peak = Math.max(peak, Math.abs(s));
  return peak;
}

function renderFrames(engine: AudioEngine, frames: number): Int16Array {
  const out = new Int16Array(frames * 2);
  let done = 0;
  const scratch = new Int16Array(CHUNK_FRAMES * 2);
  while (done < frames) {
    const n = Math.min(CHUNK_FRAMES, frames - done);
    engine.renderInto(scratch, n);
    out.set(scratch.subarray(0, n * 2), done * 2);
    done += n;
  }
  return out;
}

describe("AudioEngine", () => {
  test("ohne Events bleibt es still", () => {
    const engine = new AudioEngine(SAMPLE_RATE);
    try {
      expect(peakOf(renderFrames(engine, SAMPLE_RATE / 10))).toBe(0);
    } finally {
      engine.free();
    }
  });

  test("Kick erzeugt Signal", () => {
    const engine = new AudioEngine(SAMPLE_RATE);
    try {
      engine.schedule(0, TRACK_OF.drums, KIND_NOTE_ON, 36, 1.0);
      expect(peakOf(renderFrames(engine, SAMPLE_RATE / 10))).toBeGreaterThan(3000);
    } finally {
      engine.free();
    }
  });

  test("Event greift erst an seiner Sample-Position", () => {
    const engine = new AudioEngine(SAMPLE_RATE);
    try {
      const at = 12_000; // 0.5 s
      engine.schedule(at, TRACK_OF.drums, KIND_NOTE_ON, 36, 1.0);
      const before = renderFrames(engine, at);
      const after = renderFrames(engine, 2400);
      expect(peakOf(before)).toBe(0);
      expect(peakOf(after)).toBeGreaterThan(3000);
    } finally {
      engine.free();
    }
  });

  test("gehaltene Bassnote klingt, Note-off beendet sie", () => {
    const engine = new AudioEngine(SAMPLE_RATE);
    try {
      engine.schedule(0, TRACK_OF.bass, KIND_NOTE_ON, 40, 0.9);
      engine.schedule(4800, TRACK_OF.bass, KIND_NOTE_OFF, 40, 0);
      const sounding = renderFrames(engine, 4800);
      expect(peakOf(sounding)).toBeGreaterThan(1000);
      // After the release (0.12 s) it has to be silent.
      renderFrames(engine, SAMPLE_RATE / 2);
      expect(peakOf(renderFrames(engine, 2400))).toBe(0);
    } finally {
      engine.free();
    }
  });

  test("Gitarrensaite klingt aus", () => {
    const engine = new AudioEngine(SAMPLE_RATE);
    try {
      engine.schedule(0, TRACK_OF.guitar, KIND_NOTE_ON, 52, 0.9);
      expect(peakOf(renderFrames(engine, SAMPLE_RATE / 4))).toBeGreaterThan(500);
    } finally {
      engine.free();
    }
  });

  test("Pegelanzeige folgt dem Signal", () => {
    const engine = new AudioEngine(SAMPLE_RATE);
    try {
      engine.schedule(0, TRACK_OF.drums, KIND_NOTE_ON, 36, 1.0);
      engine.renderChunk();
      const peaks = engine.peaks();
      expect(peaks[0]!).toBeGreaterThan(0.05);
      expect(peaks[1]!).toBe(0);
      expect(peaks[4]!).toBeGreaterThan(0.05);
    } finally {
      engine.free();
    }
  });
});

describe("Transport", () => {
  test("quantisiert auf das Raster und niemals in die Vergangenheit", () => {
    const transport = new Transport(SAMPLE_RATE);
    transport.bpm = 120; // 1 beat = 12000 samples, 1/16 = 3000 samples
    transport.grid = 16;

    const q = transport.quantize(3500);
    expect(q.sample).toBe(6000);
    expect(q.beat).toBeCloseTo(0.5, 6);
    expect(q.sample).toBeGreaterThanOrEqual(3500);
  });

  test("exakt getroffene Rasterlinie wird nicht verschoben", () => {
    const transport = new Transport(SAMPLE_RATE);
    transport.bpm = 120;
    transport.grid = 16;
    expect(transport.quantize(6000).sample).toBeCloseTo(6000, 3);
  });

  test("BPM-Wechsel verschiebt die laufende Beat-Zählung nicht", () => {
    const transport = new Transport(SAMPLE_RATE);
    transport.bpm = 120;
    const beatBefore = transport.beatAt(30_000);
    transport.setBpm(90, 30_000);
    expect(transport.beatAt(30_000)).toBeCloseTo(beatBefore, 6);
  });

  test("Takt und Zählzeit zählen korrekt durch", () => {
    const transport = new Transport(SAMPLE_RATE);
    transport.bpm = 120;
    expect(transport.barBeatAt(0)).toEqual({ bar: 0, beat: 0 });
    expect(transport.barBeatAt(12_000)).toEqual({ bar: 0, beat: 1 });
    expect(transport.barBeatAt(48_000)).toEqual({ bar: 1, beat: 0 });
  });
});

describe("WAV", () => {
  test("Header beschreibt die Nutzdaten korrekt", () => {
    const pcm = new Int16Array(480 * 2);
    const wav = encodeWav(pcm, SAMPLE_RATE, 2);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
    expect(wav.length).toBe(44 + pcm.length * 2);
  });
});
