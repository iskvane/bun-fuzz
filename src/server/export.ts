/**
 * WAV export: a saved song is rendered offline through the same Rust engine it
 * sounded through live. Because the engine is deterministic (fixed RNG seed),
 * the export sounds identical to the session.
 */

import { CHANNELS, SAMPLE_RATE } from "../shared/protocol";
import { AudioEngine, CHUNK_FRAMES } from "./audio";
import type { Store } from "./db";
import { BEATS_PER_BAR } from "./transport";

/** Tail after the last note so nothing gets cut off. */
const TAIL_SECONDS = 2.5;

export function renderSongToWav(store: Store, songId: number): Uint8Array<ArrayBuffer> | null {
  const song = store.getSong(songId);
  if (!song) return null;
  const events = store.loadEvents(songId).filter((e) => e.note >= 0);
  if (events.length === 0) return null;

  const samplesPerBeat = (60 / song.bpm) * SAMPLE_RATE;
  const base = Math.floor(events[0]!.beat / BEATS_PER_BAR) * BEATS_PER_BAR;
  const lastBeat = events[events.length - 1]!.beat - base;

  const totalFrames =
    Math.ceil(lastBeat * samplesPerBeat) + Math.ceil(TAIL_SECONDS * SAMPLE_RATE);

  const engine = new AudioEngine(SAMPLE_RATE);
  try {
    for (const e of events) {
      engine.schedule((e.beat - base) * samplesPerBeat, e.track, e.kind, e.note, e.vel);
    }

    const pcm = new Int16Array(totalFrames * CHANNELS);
    // Render in chunks so the engine applies its events sample-accurately,
    // exactly as it does live.
    const scratch = new Int16Array(CHUNK_FRAMES * CHANNELS);
    let frame = 0;
    while (frame < totalFrames) {
      const frames = Math.min(CHUNK_FRAMES, totalFrames - frame);
      engine.renderInto(scratch, frames);
      pcm.set(scratch.subarray(0, frames * CHANNELS), frame * CHANNELS);
      frame += frames;
    }
    return encodeWav(pcm, SAMPLE_RATE, CHANNELS);
  } finally {
    engine.free();
  }
}

/** Minimal RIFF/WAVE container for 16-bit PCM. */
export function encodeWav(
  pcm: Int16Array,
  sampleRate: number,
  channels: number,
): Uint8Array<ArrayBuffer> {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");

  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // length of the fmt block
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // bytes per second
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  new Int16Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}
