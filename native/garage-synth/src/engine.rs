//! Mixer and event scheduler.
//!
//! The server schedules events at absolute sample positions. The engine applies
//! them sample-accurately while rendering – so every quantized note sits exactly
//! on the grid, no matter when its network packet arrived.

use crate::drums::DrumKit;
use crate::dsp::soft_clip;
use crate::guitar::Guitar;
use crate::synth::{Patch, Synth};

pub const TRACKS: usize = 4;
pub const TRACK_DRUMS: u32 = 0;
pub const TRACK_BASS: u32 = 1;
pub const TRACK_GUITAR: u32 = 2;
pub const TRACK_KEYS: u32 = 3;

pub const KIND_NOTE_OFF: u32 = 0;
pub const KIND_NOTE_ON: u32 = 1;
pub const KIND_ALL_OFF: u32 = 2;

#[derive(Clone, Copy)]
struct Event {
    at: u64,
    track: u32,
    kind: u32,
    note: i32,
    vel: f32,
}

pub struct Engine {
    pos: u64,
    /// Sorted ascending by `at`; consumed from the front.
    events: Vec<Event>,
    drums: DrumKit,
    bass: Synth,
    guitar: Guitar,
    keys: Synth,
    gains: [f32; TRACKS],
    /// -1.0 = hard left, +1.0 = hard right.
    pans: [f32; TRACKS],
    peaks: [f32; TRACKS + 1],
}

impl Engine {
    pub fn new(sample_rate: u32) -> Self {
        let sr = sample_rate as f32;
        Engine {
            pos: 0,
            events: Vec::with_capacity(256),
            drums: DrumKit::new(sr),
            bass: Synth::new(Patch::bass(), sr),
            guitar: Guitar::new(sr),
            keys: Synth::new(Patch::keys(0), sr),
            gains: [0.9, 0.9, 0.85, 0.8],
            // Guitar slightly left, keys slightly right – separates the band in the stereo field.
            pans: [0.0, 0.0, -0.35, 0.35],
            peaks: [0.0; TRACKS + 1],
        }
    }

    pub fn position(&self) -> u64 {
        self.pos
    }

    pub fn schedule(&mut self, at: u64, track: u32, kind: u32, note: i32, vel: f32) {
        // Fire already-missed events immediately rather than dropping them.
        let at = at.max(self.pos);
        let ev = Event { at, track, kind, note, vel };
        // Events usually arrive in order – appending is the common case.
        if self.events.last().map_or(true, |last| last.at <= at) {
            self.events.push(ev);
        } else {
            let idx = self.events.partition_point(|e| e.at <= at);
            self.events.insert(idx, ev);
        }
    }

    pub fn set_patch(&mut self, track: u32, patch: u32) {
        if track == TRACK_KEYS {
            self.keys.set_patch(Patch::keys(patch));
        }
    }

    pub fn set_gain(&mut self, track: u32, gain: f32) {
        if (track as usize) < TRACKS {
            self.gains[track as usize] = gain.clamp(0.0, 2.0);
        }
    }

    pub fn peaks(&self) -> [f32; TRACKS + 1] {
        self.peaks
    }

    pub fn panic(&mut self) {
        self.events.clear();
        self.bass.all_off();
        self.keys.all_off();
        self.guitar.all_off();
        self.drums.all_off();
    }

    fn apply(&mut self, ev: Event) {
        match (ev.kind, ev.track) {
            (KIND_ALL_OFF, _) => self.panic(),
            (KIND_NOTE_ON, TRACK_DRUMS) => self.drums.note_on(ev.note, ev.vel),
            (KIND_NOTE_ON, TRACK_BASS) => self.bass.note_on(ev.note, ev.vel),
            (KIND_NOTE_ON, TRACK_GUITAR) => self.guitar.note_on(ev.note, ev.vel),
            (KIND_NOTE_ON, TRACK_KEYS) => self.keys.note_on(ev.note, ev.vel),
            // Drums are one-shots and ignore note offs.
            (KIND_NOTE_OFF, TRACK_BASS) => self.bass.note_off(ev.note),
            (KIND_NOTE_OFF, TRACK_GUITAR) => self.guitar.note_off(ev.note),
            (KIND_NOTE_OFF, TRACK_KEYS) => self.keys.note_off(ev.note),
            _ => {}
        }
    }

    /// Applies every event due at the current sample position.
    fn fire_due(&mut self) {
        while let Some(&ev) = self.events.first() {
            if ev.at > self.pos {
                break;
            }
            self.events.remove(0);
            self.apply(ev);
        }
    }

    /// Renders `frames` stereo frames as interleaved i16 into `out`.
    /// `out` must hold at least `frames * 2` values.
    pub fn render(&mut self, out: &mut [i16], frames: usize) {
        let mut track_peaks = [0.0f32; TRACKS];
        let mut master_peak = 0.0f32;

        // Pan factors once up front instead of recomputing them per sample.
        let mut pan_l = [0.0f32; TRACKS];
        let mut pan_r = [0.0f32; TRACKS];
        for t in 0..TRACKS {
            let angle = (self.pans[t] + 1.0) * 0.5 * std::f32::consts::FRAC_PI_2;
            pan_l[t] = angle.cos();
            pan_r[t] = angle.sin();
        }

        for f in 0..frames {
            self.fire_due();

            let voices = [
                self.drums.render(),
                self.bass.render(),
                self.guitar.render(),
                self.keys.render(),
            ];

            let mut l = 0.0f32;
            let mut r = 0.0f32;
            for t in 0..TRACKS {
                let s = voices[t] * self.gains[t];
                let a = s.abs();
                if a > track_peaks[t] {
                    track_peaks[t] = a;
                }
                l += s * pan_l[t];
                r += s * pan_r[t];
            }

            let l = soft_clip(l * 0.8);
            let r = soft_clip(r * 0.8);
            let m = l.abs().max(r.abs());
            if m > master_peak {
                master_peak = m;
            }

            out[f * 2] = to_i16(l);
            out[f * 2 + 1] = to_i16(r);
            self.pos += 1;
        }

        // Peaks decay instead of resetting, so the VU display doesn't flicker.
        for t in 0..TRACKS {
            self.peaks[t] = track_peaks[t].max(self.peaks[t] * 0.65);
        }
        self.peaks[TRACKS] = master_peak.max(self.peaks[TRACKS] * 0.65);
    }
}

#[inline]
fn to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * 32767.0) as i16
}
