/**
 * Binding to the Rust audio engine via `bun:ffi`.
 *
 * Deliberately without node-gyp and without a zoo of build scripts:
 * `cargo build --release` produces a cdylib, `dlopen` pulls it in at runtime.
 * That is the entire native build step.
 */

import { dlopen, FFIType, suffix } from "bun:ffi";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LIB_BASENAME = "garage_synth";

/** Platform file name of the cdylib: garage_synth.dll / libgarage_synth.so / .dylib */
function libFileName(): string {
  return process.platform === "win32"
    ? `${LIB_BASENAME}.${suffix}`
    : `lib${LIB_BASENAME}.${suffix}`;
}

/**
 * Looks for the library everywhere it realistically lives: explicitly
 * configured, next to the compiled binary, or in the cargo target directory
 * during development.
 */
function resolveLibPath(): string {
  const file = libFileName();
  const candidates = [
    process.env.GARAGE_SYNTH_LIB,
    join(dirname(process.execPath), file),
    resolve(import.meta.dir, "../../native/garage-synth/target/release", file),
    resolve(process.cwd(), "native/garage-synth/target/release", file),
    resolve(process.cwd(), file),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Audio-Engine nicht gefunden (${file}).\n` +
      `Gesucht in:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Bauen mit: bun run build:native`,
  );
}

export const LIB_PATH = resolveLibPath();

const { symbols, close } = dlopen(LIB_PATH, {
  ge_new: { args: [FFIType.u32], returns: FFIType.ptr },
  ge_free: { args: [FFIType.ptr], returns: FFIType.void },
  ge_schedule: {
    // ptr, at (sample position as f64), track, kind, note, velocity
    args: [FFIType.ptr, FFIType.f64, FFIType.u32, FFIType.u32, FFIType.i32, FFIType.f32],
    returns: FFIType.void,
  },
  ge_render: {
    // ptr, out (i16 buffer), frames -> new sample position
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.f64,
  },
  ge_set_patch: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.void },
  ge_set_gain: { args: [FFIType.ptr, FFIType.u32, FFIType.f32], returns: FFIType.void },
  ge_peaks: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
  ge_panic: { args: [FFIType.ptr], returns: FFIType.void },
});

export const native = symbols;
export const closeLibrary = close;

/** Event kinds, mirroring the constants in engine.rs. */
export const KIND_NOTE_OFF = 0;
export const KIND_NOTE_ON = 1;
export const KIND_ALL_OFF = 2;
