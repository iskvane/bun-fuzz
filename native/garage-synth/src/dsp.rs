//! Small DSP building blocks shared by all instruments.

use std::f32::consts::PI;

pub const TWO_PI: f32 = 2.0 * PI;

/// Xorshift RNG. Deterministic so an offline render produces the same result as
/// the live mix (which is what makes the WAV export faithful).
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(if seed == 0 { 0x9E3779B9 } else { seed })
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// White noise in the range -1.0 ..= 1.0
    #[inline]
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

#[inline]
pub fn midi_to_hz(note: f32) -> f32 {
    440.0 * ((note - 69.0) / 12.0).exp2()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// Linear ADSR envelope. Sonically plenty, and cheap.
#[derive(Clone, Copy)]
pub struct Env {
    stage: Stage,
    level: f32,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    release_rate: f32,
    sr: f32,
}

impl Env {
    pub fn new(sr: f32) -> Self {
        Env {
            stage: Stage::Idle,
            level: 0.0,
            attack: 0.005,
            decay: 0.1,
            sustain: 0.7,
            release: 0.3,
            release_rate: 0.0,
            sr,
        }
    }

    pub fn set(&mut self, a: f32, d: f32, s: f32, r: f32) {
        self.attack = a.max(0.0005);
        self.decay = d.max(0.0005);
        self.sustain = s.clamp(0.0, 1.0);
        self.release = r.max(0.0005);
    }

    pub fn gate_on(&mut self) {
        self.stage = Stage::Attack;
    }

    pub fn gate_off(&mut self) {
        if self.stage != Stage::Idle {
            // Run from the current level down to 0 over `release` seconds.
            self.release_rate = self.level / (self.release * self.sr);
            self.stage = Stage::Release;
        }
    }

    pub fn active(&self) -> bool {
        self.stage != Stage::Idle
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        match self.stage {
            Stage::Idle => return 0.0,
            Stage::Attack => {
                self.level += 1.0 / (self.attack * self.sr);
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.level -= (1.0 - self.sustain) / (self.decay * self.sr);
                if self.level <= self.sustain {
                    self.level = self.sustain;
                    self.stage = if self.sustain <= 0.0 {
                        Stage::Idle
                    } else {
                        Stage::Sustain
                    };
                }
            }
            Stage::Sustain => {}
            Stage::Release => {
                self.level -= self.release_rate;
                if self.level <= 0.0 {
                    self.level = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.level
    }
}

/// Exponentially decaying envelope for percussive sounds.
#[derive(Clone, Copy)]
pub struct Decay {
    level: f32,
    coeff: f32,
}

impl Decay {
    pub fn new() -> Self {
        Decay { level: 0.0, coeff: 0.999 }
    }

    /// `time` = time to reach roughly -60 dB.
    pub fn trigger(&mut self, level: f32, time: f32, sr: f32) {
        self.level = level;
        self.coeff = (-6.9078 / (time * sr)).exp();
    }

    pub fn active(&self) -> bool {
        self.level > 0.0001
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        let v = self.level;
        self.level *= self.coeff;
        v
    }
}

/// PolyBLEP oscillator: saw/square without gross aliasing.
#[derive(Clone, Copy)]
pub struct Osc {
    phase: f32,
    inc: f32,
}

impl Osc {
    pub fn new() -> Self {
        Osc { phase: 0.0, inc: 0.0 }
    }

    pub fn with_phase(phase: f32) -> Self {
        Osc { phase, inc: 0.0 }
    }

    pub fn set_freq(&mut self, hz: f32, sr: f32) {
        self.inc = (hz / sr).clamp(0.0, 0.49);
    }

    #[inline]
    fn advance(&mut self) {
        self.phase += self.inc;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
    }

    #[inline]
    pub fn sine(&mut self) -> f32 {
        let v = (self.phase * TWO_PI).sin();
        self.advance();
        v
    }

    #[inline]
    pub fn saw(&mut self) -> f32 {
        let mut v = 2.0 * self.phase - 1.0;
        v -= poly_blep(self.phase, self.inc);
        self.advance();
        v
    }

    #[inline]
    pub fn square(&mut self, pw: f32) -> f32 {
        let mut v = if self.phase < pw { 1.0 } else { -1.0 };
        v += poly_blep(self.phase, self.inc);
        let t = self.phase + (1.0 - pw);
        v -= poly_blep(if t >= 1.0 { t - 1.0 } else { t }, self.inc);
        self.advance();
        v
    }
}

#[inline]
fn poly_blep(t: f32, dt: f32) -> f32 {
    if dt <= 0.0 {
        return 0.0;
    }
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

/// State variable filter in TPT form (Zavalishin). Stable up to near Nyquist.
#[derive(Clone, Copy)]
pub struct Svf {
    ic1: f32,
    ic2: f32,
}

pub struct SvfOut {
    pub lp: f32,
    pub hp: f32,
}

impl Svf {
    pub fn new() -> Self {
        Svf { ic1: 0.0, ic2: 0.0 }
    }

    #[inline]
    pub fn process(&mut self, x: f32, cutoff_hz: f32, q: f32, sr: f32) -> SvfOut {
        let fc = cutoff_hz.clamp(20.0, sr * 0.45);
        let g = (PI * fc / sr).tan();
        let k = 1.0 / q.max(0.05);
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;

        let v3 = x - self.ic2;
        let v1 = a1 * self.ic1 + a2 * v3;
        let v2 = self.ic2 + a2 * self.ic1 + a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;

        let lp = v2;
        let hp = x - k * v1 - v2;
        SvfOut { lp, hp }
    }

    #[inline]
    pub fn lowpass(&mut self, x: f32, cutoff_hz: f32, q: f32, sr: f32) -> f32 {
        self.process(x, cutoff_hz, q, sr).lp
    }

    #[inline]
    pub fn highpass(&mut self, x: f32, cutoff_hz: f32, q: f32, sr: f32) -> f32 {
        self.process(x, cutoff_hz, q, sr).hp
    }
}

/// Delay line with linear interpolation – the basis of the Karplus-Strong string.
pub struct Delay {
    buf: Vec<f32>,
    write: usize,
}

impl Delay {
    pub fn new(max_len: usize) -> Self {
        Delay {
            buf: vec![0.0; max_len.max(2)],
            write: 0,
        }
    }

    pub fn clear(&mut self) {
        self.buf.iter_mut().for_each(|s| *s = 0.0);
        self.write = 0;
    }

    /// Places the excitation exactly where the read head picks it up next: on the
    /// `values.len()` positions immediately before the write pointer.
    pub fn excite(&mut self, values: &[f32]) {
        let cap = self.buf.len();
        if values.is_empty() || values.len() > cap {
            return;
        }
        let start = (self.write + cap - values.len()) % cap;
        for (i, v) in values.iter().enumerate() {
            self.buf[(start + i) % cap] = *v;
        }
    }

    #[inline]
    pub fn read(&self, delay_samples: f32) -> f32 {
        let n = self.buf.len() as f32;
        let mut pos = self.write as f32 - delay_samples;
        while pos < 0.0 {
            pos += n;
        }
        let i0 = pos.floor() as usize % self.buf.len();
        let i1 = (i0 + 1) % self.buf.len();
        let frac = pos - pos.floor();
        self.buf[i0] * (1.0 - frac) + self.buf[i1] * frac
    }

    #[inline]
    pub fn write_sample(&mut self, v: f32) {
        self.buf[self.write] = v;
        self.write = (self.write + 1) % self.buf.len();
    }
}

/// Soft saturation – holds the master bus together without hard clipping.
#[inline]
pub fn soft_clip(x: f32) -> f32 {
    x.tanh()
}
