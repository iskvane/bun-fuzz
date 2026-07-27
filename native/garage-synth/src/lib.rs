//! C ABI surface for Bun FFI.
//!
//! Deliberately narrow: pointers in, numbers in, samples out. Sample positions
//! cross the boundary as `f64` rather than `u64` so the JS side needs no BigInt
//! handling – up to 2^53 samples (over 11000 years at 24 kHz) that is exact.

mod drums;
mod dsp;
mod engine;
mod guitar;
mod synth;

use engine::{Engine, TRACKS};

/// Creates a new engine. Returns an owning pointer that must go to `ge_free`.
#[no_mangle]
pub extern "C" fn ge_new(sample_rate: u32) -> *mut Engine {
    let sr = if sample_rate == 0 { 24_000 } else { sample_rate };
    Box::into_raw(Box::new(Engine::new(sr)))
}

#[no_mangle]
pub extern "C" fn ge_free(ptr: *mut Engine) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr)) };
    }
}

/// Schedules an event at an absolute sample position.
/// `kind`: 0 = note off, 1 = note on, 2 = all off.
#[no_mangle]
pub extern "C" fn ge_schedule(
    ptr: *mut Engine,
    at: f64,
    track: u32,
    kind: u32,
    note: i32,
    vel: f32,
) {
    let Some(engine) = (unsafe { ptr.as_mut() }) else {
        return;
    };
    let at = if at < 0.0 { 0 } else { at as u64 };
    engine.schedule(at, track, kind, note, vel);
}

/// Renders `frames` interleaved stereo frames into `out` (length >= frames*2).
/// Returns the engine's new sample position.
#[no_mangle]
pub extern "C" fn ge_render(ptr: *mut Engine, out: *mut i16, frames: u32) -> f64 {
    let Some(engine) = (unsafe { ptr.as_mut() }) else {
        return 0.0;
    };
    if out.is_null() || frames == 0 {
        return engine.position() as f64;
    }
    let n = frames as usize;
    let buf = unsafe { std::slice::from_raw_parts_mut(out, n * 2) };
    engine.render(buf, n);
    engine.position() as f64
}

#[no_mangle]
pub extern "C" fn ge_set_patch(ptr: *mut Engine, track: u32, patch: u32) {
    if let Some(engine) = unsafe { ptr.as_mut() } {
        engine.set_patch(track, patch);
    }
}

#[no_mangle]
pub extern "C" fn ge_set_gain(ptr: *mut Engine, track: u32, gain: f32) {
    if let Some(engine) = unsafe { ptr.as_mut() } {
        engine.set_gain(track, gain);
    }
}

/// Writes 5 peak values into `out`: the four tracks, then the master.
#[no_mangle]
pub extern "C" fn ge_peaks(ptr: *mut Engine, out: *mut f32) {
    let Some(engine) = (unsafe { ptr.as_mut() }) else {
        return;
    };
    if out.is_null() {
        return;
    }
    let peaks = engine.peaks();
    let buf = unsafe { std::slice::from_raw_parts_mut(out, TRACKS + 1) };
    buf.copy_from_slice(&peaks);
}

/// Stops all sounding voices immediately and discards scheduled events.
#[no_mangle]
pub extern "C" fn ge_panic(ptr: *mut Engine) {
    if let Some(engine) = unsafe { ptr.as_mut() } {
        engine.panic();
    }
}
