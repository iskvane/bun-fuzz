//! Guitar as a Karplus-Strong model: a delay line filled with noise whose
//! feedback path is gently low-passed. Sounds far more like a plucked string
//! than an oscillator synth does.

use crate::dsp::{midi_to_hz, Delay, Rng, Svf};

const STRINGS: usize = 8;
const MAX_DELAY: usize = 2048;

struct GString {
    delay: Delay,
    len: f32,
    prev: f32,
    feedback: f32,
    active: bool,
    note: i32,
    age: u64,
    /// Envelope follower, used to detect when the string has died away.
    envelope: f32,
    quiet_for: u32,
}

impl GString {
    fn new() -> Self {
        GString {
            delay: Delay::new(MAX_DELAY),
            len: 100.0,
            prev: 0.0,
            feedback: 0.995,
            active: false,
            note: -1,
            age: 0,
            envelope: 0.0,
            quiet_for: 0,
        }
    }

    fn pluck(&mut self, note: i32, vel: f32, sr: f32, rng: &mut Rng, age: u64) {
        let hz = midi_to_hz(note as f32);
        self.len = (sr / hz).clamp(4.0, (MAX_DELAY - 2) as f32);
        self.delay.clear();
        self.prev = 0.0;

        // Excitation: noise across the length of the string, scaled by velocity.
        // A gentle window takes the harshness off the attack.
        let n = self.len as usize;
        let amp = vel.clamp(0.05, 1.0);
        let mut last = 0.0f32;
        let values: Vec<f32> = (0..n)
            .map(|i| {
                let w = (i as f32 / n as f32 * std::f32::consts::PI).sin();
                let raw = rng.next_f32() * amp * w;
                // Simple smoothing: removes the shrillest components.
                last = 0.6 * raw + 0.4 * last;
                last
            })
            .collect();
        self.delay.excite(&values);

        // High notes ring out shorter than low ones – like a real string does.
        self.feedback = (0.9965 - (hz / 4000.0) * 0.02).clamp(0.95, 0.9985);
        self.active = true;
        self.note = note;
        self.age = age;
        self.envelope = amp;
        self.quiet_for = 0;
    }

    /// Note off damps the string rather than cutting it off abruptly.
    fn damp(&mut self) {
        self.feedback = 0.88;
    }

    #[inline]
    fn next(&mut self) -> f32 {
        let y = self.delay.read(self.len);
        // Low-pass in the feedback path = the characteristic decay.
        let filtered = 0.5 * (y + self.prev);
        self.prev = filtered;
        self.delay.write_sample(filtered * self.feedback);

        let a = y.abs();
        self.envelope = if a > self.envelope {
            a
        } else {
            self.envelope * 0.9995
        };
        if self.envelope < 0.0004 {
            self.quiet_for += 1;
            if self.quiet_for > 1000 {
                self.active = false;
            }
        } else {
            self.quiet_for = 0;
        }
        y
    }
}

pub struct Guitar {
    strings: Vec<GString>,
    body: Svf,
    rng: Rng,
    sr: f32,
    counter: u64,
}

impl Guitar {
    pub fn new(sr: f32) -> Self {
        Guitar {
            strings: (0..STRINGS).map(|_| GString::new()).collect(),
            body: Svf::new(),
            rng: Rng::new(0x51EE_D0C5),
            sr,
            counter: 0,
        }
    }

    pub fn note_on(&mut self, note: i32, vel: f32) {
        self.counter += 1;
        // Same note again? Then re-pluck the same string.
        let slot = self
            .strings
            .iter()
            .position(|s| s.active && s.note == note)
            .or_else(|| self.strings.iter().position(|s| !s.active))
            .unwrap_or_else(|| {
                // All taken: recycle the oldest string.
                let mut oldest = 0;
                for (i, s) in self.strings.iter().enumerate() {
                    if s.age < self.strings[oldest].age {
                        oldest = i;
                    }
                }
                oldest
            });

        let counter = self.counter;
        let Guitar { strings, rng, sr, .. } = self;
        strings[slot].pluck(note, vel, *sr, rng, counter);
    }

    pub fn note_off(&mut self, note: i32) {
        for s in self.strings.iter_mut() {
            if s.active && s.note == note {
                s.damp();
            }
        }
    }

    pub fn all_off(&mut self) {
        for s in self.strings.iter_mut() {
            s.active = false;
            s.delay.clear();
            s.prev = 0.0;
        }
    }

    pub fn render(&mut self) -> f32 {
        let mut out = 0.0;
        for s in self.strings.iter_mut() {
            if s.active {
                out += s.next();
            }
        }
        // Slight body resonance: takes the digital edge off the sound.
        let sr = self.sr;
        self.body.lowpass(out * 0.55, 3800.0, 0.9, sr)
    }
}
