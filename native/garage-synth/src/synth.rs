//! Subtractive polysynth. Bass and keys use the same machine, just with
//! different patches.

use crate::dsp::{midi_to_hz, Decay, Env, Osc, Svf};

const VOICES: usize = 12;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Wave {
    Saw,
    Square,
}

#[derive(Clone, Copy)]
pub struct Patch {
    pub wave: Wave,
    pub pulse_width: f32,
    /// Detune of the second oscillator, in cents.
    pub detune_cents: f32,
    /// Level of the sub oscillator (one octave down).
    pub sub: f32,
    pub cutoff: f32,
    pub resonance: f32,
    /// How far the filter envelope opens the cutoff, in Hz.
    pub env_amount: f32,
    pub filt_decay: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    pub level: f32,
}

impl Patch {
    pub fn bass() -> Self {
        Patch {
            wave: Wave::Saw,
            pulse_width: 0.5,
            detune_cents: 7.0,
            sub: 0.6,
            cutoff: 190.0,
            resonance: 1.1,
            env_amount: 1500.0,
            filt_decay: 0.22,
            attack: 0.004,
            decay: 0.20,
            sustain: 0.72,
            release: 0.12,
            level: 0.55,
        }
    }

    /// Keys patches, index = the `patch` parameter from the protocol.
    pub fn keys(index: u32) -> Self {
        match index {
            1 => Patch {
                // Pad: slow, wide, soft
                wave: Wave::Saw,
                pulse_width: 0.5,
                detune_cents: 16.0,
                sub: 0.2,
                cutoff: 620.0,
                resonance: 0.8,
                env_amount: 700.0,
                filt_decay: 1.2,
                attack: 0.35,
                decay: 0.7,
                sustain: 0.8,
                release: 0.9,
                level: 0.30,
            },
            2 => Patch {
                // Arpeggio: short and percussive
                wave: Wave::Square,
                pulse_width: 0.34,
                detune_cents: 5.0,
                sub: 0.0,
                cutoff: 1400.0,
                resonance: 1.6,
                env_amount: 3200.0,
                filt_decay: 0.12,
                attack: 0.002,
                decay: 0.13,
                sustain: 0.0,
                release: 0.10,
                level: 0.34,
            },
            _ => Patch {
                // Lead: direct, singing
                wave: Wave::Saw,
                pulse_width: 0.5,
                detune_cents: 11.0,
                sub: 0.0,
                cutoff: 850.0,
                resonance: 1.3,
                env_amount: 2600.0,
                filt_decay: 0.35,
                attack: 0.008,
                decay: 0.18,
                sustain: 0.68,
                release: 0.22,
                level: 0.36,
            },
        }
    }
}

struct Voice {
    osc1: Osc,
    osc2: Osc,
    sub: Osc,
    amp: Env,
    filt: Decay,
    filter: Svf,
    note: i32,
    vel: f32,
    active: bool,
    age: u64,
}

impl Voice {
    fn new(sr: f32) -> Self {
        Voice {
            osc1: Osc::new(),
            osc2: Osc::with_phase(0.37),
            sub: Osc::with_phase(0.11),
            amp: Env::new(sr),
            filt: Decay::new(),
            filter: Svf::new(),
            note: -1,
            vel: 0.0,
            active: false,
            age: 0,
        }
    }

    fn start(&mut self, note: i32, vel: f32, patch: &Patch, sr: f32, age: u64) {
        let hz = midi_to_hz(note as f32);
        let detune = (patch.detune_cents / 1200.0).exp2();
        self.osc1.set_freq(hz, sr);
        self.osc2.set_freq(hz * detune, sr);
        self.sub.set_freq(hz * 0.5, sr);
        self.amp
            .set(patch.attack, patch.decay, patch.sustain, patch.release);
        self.amp.gate_on();
        self.filt.trigger(1.0, patch.filt_decay, sr);
        self.note = note;
        self.vel = vel.clamp(0.05, 1.0);
        self.active = true;
        self.age = age;
    }

    #[inline]
    fn next(&mut self, patch: &Patch, sr: f32) -> f32 {
        let a = self.amp.next();
        if !self.amp.active() {
            self.active = false;
            return 0.0;
        }

        let o1 = match patch.wave {
            Wave::Saw => self.osc1.saw(),
            Wave::Square => self.osc1.square(patch.pulse_width),
        };
        let o2 = match patch.wave {
            Wave::Saw => self.osc2.saw(),
            Wave::Square => self.osc2.square(patch.pulse_width),
        };
        let mut s = o1 + o2 * 0.75;
        if patch.sub > 0.0 {
            s += self.sub.sine() * patch.sub;
        }

        let cutoff = patch.cutoff + self.filt.next() * patch.env_amount * self.vel;
        let s = self.filter.lowpass(s, cutoff, patch.resonance, sr);
        s * a * self.vel
    }
}

pub struct Synth {
    voices: Vec<Voice>,
    patch: Patch,
    sr: f32,
    counter: u64,
}

impl Synth {
    pub fn new(patch: Patch, sr: f32) -> Self {
        Synth {
            voices: (0..VOICES).map(|_| Voice::new(sr)).collect(),
            patch,
            sr,
            counter: 0,
        }
    }

    pub fn set_patch(&mut self, patch: Patch) {
        self.patch = patch;
    }

    pub fn note_on(&mut self, note: i32, vel: f32) {
        self.counter += 1;
        let slot = self
            .voices
            .iter()
            .position(|v| v.active && v.note == note)
            .or_else(|| self.voices.iter().position(|v| !v.active))
            .unwrap_or_else(|| {
                let mut oldest = 0;
                for (i, v) in self.voices.iter().enumerate() {
                    if v.age < self.voices[oldest].age {
                        oldest = i;
                    }
                }
                oldest
            });
        let (patch, sr, counter) = (self.patch, self.sr, self.counter);
        self.voices[slot].start(note, vel, &patch, sr, counter);
    }

    pub fn note_off(&mut self, note: i32) {
        for v in self.voices.iter_mut() {
            if v.active && v.note == note {
                v.amp.gate_off();
            }
        }
    }

    pub fn all_off(&mut self) {
        for v in self.voices.iter_mut() {
            v.active = false;
            v.amp = Env::new(self.sr);
        }
    }

    pub fn render(&mut self) -> f32 {
        let (patch, sr) = (self.patch, self.sr);
        let mut out = 0.0;
        for v in self.voices.iter_mut() {
            if v.active {
                out += v.next(&patch, sr);
            }
        }
        out * patch.level
    }
}
