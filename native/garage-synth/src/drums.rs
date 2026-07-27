//! Drum kit: one fixed voice per instrument, simply retriggered when hit again
//! (which is how real drum machines behave too).

use crate::dsp::{Decay, Osc, Rng, Svf};

/// Kick: sine with a falling pitch plus a short click component.
struct Kick {
    osc: Osc,
    amp: Decay,
    pitch: Decay,
    click: Decay,
    sr: f32,
}

impl Kick {
    fn new(sr: f32) -> Self {
        Kick {
            osc: Osc::new(),
            amp: Decay::new(),
            pitch: Decay::new(),
            click: Decay::new(),
            sr,
        }
    }

    fn trigger(&mut self, vel: f32) {
        self.amp.trigger(vel, 0.42, self.sr);
        self.pitch.trigger(1.0, 0.045, self.sr);
        self.click.trigger(vel * 0.5, 0.006, self.sr);
    }

    fn active(&self) -> bool {
        self.amp.active()
    }

    fn next(&mut self, rng: &mut Rng) -> f32 {
        let p = self.pitch.next();
        // 48 Hz fundamental, pulled up to ~160 Hz during the attack.
        self.osc.set_freq(48.0 + p * 112.0, self.sr);
        let body = self.osc.sine() * self.amp.next();
        let click = rng.next_f32() * self.click.next();
        body * 1.1 + click
    }
}

/// Snare: noise bed plus two tuned components for the head tone.
struct Snare {
    tone_a: Osc,
    tone_b: Osc,
    amp: Decay,
    tone_amp: Decay,
    filt: Svf,
    sr: f32,
}

impl Snare {
    fn new(sr: f32) -> Self {
        Snare {
            tone_a: Osc::new(),
            tone_b: Osc::with_phase(0.25),
            amp: Decay::new(),
            tone_amp: Decay::new(),
            filt: Svf::new(),
            sr,
        }
    }

    fn trigger(&mut self, vel: f32) {
        self.amp.trigger(vel, 0.19, self.sr);
        self.tone_amp.trigger(vel * 0.7, 0.11, self.sr);
        self.tone_a.set_freq(185.0, self.sr);
        self.tone_b.set_freq(331.0, self.sr);
    }

    fn active(&self) -> bool {
        self.amp.active()
    }

    fn next(&mut self, rng: &mut Rng) -> f32 {
        let noise = rng.next_f32() * self.amp.next();
        let noise = self.filt.highpass(noise, 1300.0, 0.8, self.sr);
        let t = self.tone_amp.next();
        let tone = (self.tone_a.sine() * 0.6 + self.tone_b.sine() * 0.4) * t;
        noise * 0.9 + tone * 0.5
    }
}

/// Hi-hat: filtered noise. Closed and open share one voice so a closed hit
/// chokes the open one.
struct Hat {
    amp: Decay,
    filt: Svf,
    sr: f32,
}

impl Hat {
    fn new(sr: f32) -> Self {
        Hat {
            amp: Decay::new(),
            filt: Svf::new(),
            sr,
        }
    }

    fn trigger(&mut self, vel: f32, open: bool) {
        let time = if open { 0.38 } else { 0.055 };
        self.amp.trigger(vel * 0.8, time, self.sr);
    }

    fn active(&self) -> bool {
        self.amp.active()
    }

    fn next(&mut self, rng: &mut Rng) -> f32 {
        let n = rng.next_f32() * self.amp.next();
        self.filt.highpass(n, 7200.0, 0.7, self.sr)
    }
}

/// Tom: like the kick, just tuned higher and longer.
struct Tom {
    osc: Osc,
    amp: Decay,
    pitch: Decay,
    base_hz: f32,
    sr: f32,
}

impl Tom {
    fn new(base_hz: f32, sr: f32) -> Self {
        Tom {
            osc: Osc::new(),
            amp: Decay::new(),
            pitch: Decay::new(),
            base_hz,
            sr,
        }
    }

    fn trigger(&mut self, vel: f32) {
        self.amp.trigger(vel, 0.38, self.sr);
        self.pitch.trigger(1.0, 0.08, self.sr);
    }

    fn active(&self) -> bool {
        self.amp.active()
    }

    fn next(&mut self) -> f32 {
        let p = self.pitch.next();
        self.osc
            .set_freq(self.base_hz * (1.0 + p * 0.75), self.sr);
        self.osc.sine() * self.amp.next()
    }
}

/// Crash: long, high-pass filtered noise.
struct Crash {
    amp: Decay,
    filt: Svf,
    sr: f32,
}

impl Crash {
    fn new(sr: f32) -> Self {
        Crash {
            amp: Decay::new(),
            filt: Svf::new(),
            sr,
        }
    }

    fn trigger(&mut self, vel: f32) {
        self.amp.trigger(vel * 0.6, 1.6, self.sr);
    }

    fn active(&self) -> bool {
        self.amp.active()
    }

    fn next(&mut self, rng: &mut Rng) -> f32 {
        let n = rng.next_f32() * self.amp.next();
        self.filt.highpass(n, 5000.0, 0.6, self.sr)
    }
}

pub struct DrumKit {
    kick: Kick,
    snare: Snare,
    hat: Hat,
    tom_low: Tom,
    tom_high: Tom,
    crash: Crash,
    rng: Rng,
}

impl DrumKit {
    pub fn new(sr: f32) -> Self {
        DrumKit {
            kick: Kick::new(sr),
            snare: Snare::new(sr),
            hat: Hat::new(sr),
            tom_low: Tom::new(110.0, sr),
            tom_high: Tom::new(165.0, sr),
            crash: Crash::new(sr),
            rng: Rng::new(0x2BAD_F00D),
        }
    }

    /// Note numbers loosely follow the General MIDI mapping.
    pub fn note_on(&mut self, note: i32, vel: f32) {
        match note {
            36 => self.kick.trigger(vel),
            38 | 40 => self.snare.trigger(vel),
            42 | 44 => self.hat.trigger(vel, false),
            46 => self.hat.trigger(vel, true),
            45 | 41 => self.tom_low.trigger(vel),
            48 | 47 => self.tom_high.trigger(vel),
            49 | 51 | 57 => self.crash.trigger(vel),
            _ => self.snare.trigger(vel),
        }
    }

    pub fn all_off(&mut self) {
        let sr = self.kick.sr;
        *self = DrumKit::new(sr);
    }

    pub fn render(&mut self) -> f32 {
        let mut out = 0.0;
        if self.kick.active() {
            out += self.kick.next(&mut self.rng);
        }
        if self.snare.active() {
            out += self.snare.next(&mut self.rng);
        }
        if self.hat.active() {
            out += self.hat.next(&mut self.rng);
        }
        if self.tom_low.active() {
            out += self.tom_low.next();
        }
        if self.tom_high.active() {
            out += self.tom_high.next();
        }
        if self.crash.active() {
            out += self.crash.next(&mut self.rng);
        }
        out * 0.7
    }
}
