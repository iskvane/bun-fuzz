/**
 * The four role views. Each builds its own control panel and only ever sends
 * events – sound is always produced on the server.
 */

import { DRUM_NOTES, KEYS_PATCHES, type ClientMessage, type Role } from "../shared/protocol";

export interface InstrumentView {
  el: HTMLElement;
  /** Feedback for when the server actually strikes the note. */
  flash(note: number): void;
  dispose(): void;
}

type Send = (msg: ClientMessage) => void;

const DEFAULT_VELOCITY = 0.85;

/** Semitone offset per computer key, one octave plus a bit of the next. */
const KEY_OFFSETS: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7,
  y: 8, z: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ";": 16, "ö": 16,
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const IS_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

function noteLabel(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// Drums
// ---------------------------------------------------------------------------

const DRUM_PADS: { note: number; label: string; key: string }[] = [
  { note: DRUM_NOTES.kick, label: "Kick", key: "a" },
  { note: DRUM_NOTES.snare, label: "Snare", key: "s" },
  { note: DRUM_NOTES.hihat, label: "HiHat", key: "d" },
  { note: DRUM_NOTES.openhat, label: "Open HH", key: "f" },
  { note: DRUM_NOTES.tomLow, label: "Tom low", key: "j" },
  { note: DRUM_NOTES.tomHigh, label: "Tom high", key: "k" },
  { note: DRUM_NOTES.crash, label: "Crash", key: "l" },
];

function buildDrums(send: Send): InstrumentView {
  const root = el("div", "instrument drums");
  root.append(el("p", "hint", "Click pads or press keys A S D F · J K L."));
  const grid = el("div", "pad-grid");
  const pads = new Map<number, HTMLElement>();

  for (const pad of DRUM_PADS) {
    const button = el("button", "pad");
    button.append(el("span", "pad-label", pad.label), el("kbd", undefined, pad.key.toUpperCase()));
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      send({ t: "note", note: pad.note, vel: DEFAULT_VELOCITY, on: true });
      button.classList.add("pressed");
    });
    const up = () => button.classList.remove("pressed");
    button.addEventListener("pointerup", up);
    button.addEventListener("pointerleave", up);
    pads.set(pad.note, button);
    grid.append(button);
  }
  root.append(grid);

  const byKey = new Map(DRUM_PADS.map((p) => [p.key, p]));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || event.metaKey || event.ctrlKey) return;
    const pad = byKey.get(event.key.toLowerCase());
    if (!pad) return;
    event.preventDefault();
    send({ t: "note", note: pad.note, vel: DEFAULT_VELOCITY, on: true });
    pads.get(pad.note)?.classList.add("pressed");
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const pad = byKey.get(event.key.toLowerCase());
    if (pad) pads.get(pad.note)?.classList.remove("pressed");
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return {
    el: root,
    flash(note) {
      const pad = pads.get(note);
      if (!pad) return;
      pad.classList.add("fired");
      setTimeout(() => pad.classList.remove("fired"), 110);
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    },
  };
}

// ---------------------------------------------------------------------------
// Keyboard (bass and keys)
// ---------------------------------------------------------------------------

interface KeyboardOptions {
  lowNote: number;
  octaves: number;
  send: Send;
  /** Additionally shows the computer key assignment. */
  showKeyHints: boolean;
}

function buildKeyboard(opts: KeyboardOptions): InstrumentView {
  const { lowNote, octaves, send } = opts;
  const root = el("div", "keyboard");
  const keys = new Map<number, HTMLElement>();
  const held = new Set<number>();

  // Base octave for the computer keyboard, shiftable with the arrow keys.
  let octaveShift = 0;

  const press = (note: number) => {
    if (held.has(note)) return;
    held.add(note);
    send({ t: "note", note, vel: DEFAULT_VELOCITY, on: true });
    keys.get(note)?.classList.add("pressed");
  };
  const release = (note: number) => {
    if (!held.delete(note)) return;
    send({ t: "note", note, vel: 0, on: false });
    keys.get(note)?.classList.remove("pressed");
  };

  for (let i = 0; i < octaves * 12; i++) {
    const note = lowNote + i;
    const black = IS_BLACK[note % 12]!;
    const key = el("button", black ? "key black" : "key white");
    key.dataset.note = String(note);
    key.title = noteLabel(note);
    if (!black) key.append(el("span", "key-name", noteLabel(note)));

    key.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      press(note);
    });
    key.addEventListener("pointerup", () => release(note));
    key.addEventListener("pointerleave", () => release(note));

    keys.set(note, key);
    root.append(key);
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const dir = event.key === "ArrowUp" ? 1 : -1;
      octaveShift = Math.max(-2, Math.min(2, octaveShift + dir));
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    const offset = KEY_OFFSETS[event.key.toLowerCase()];
    if (offset === undefined) return;
    event.preventDefault();
    press(lowNote + offset + octaveShift * 12);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const offset = KEY_OFFSETS[event.key.toLowerCase()];
    if (offset === undefined) return;
    release(lowNote + offset + octaveShift * 12);
  };
  const onBlur = () => {
    for (const note of [...held]) release(note);
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return {
    el: root,
    flash(note) {
      const key = keys.get(note);
      if (!key) return;
      key.classList.add("fired");
      setTimeout(() => key.classList.remove("fired"), 130);
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      onBlur();
    },
  };
}

function buildBass(send: Send): InstrumentView {
  const root = el("div", "instrument bass");
  root.append(
    el("p", "hint", "Two octaves starting from E1. Keys A W S E D … · Up/Down arrows shift the octave."),
  );
  // E1 = 28: the classic range of a four-string bass.
  const keyboard = buildKeyboard({ lowNote: 28, octaves: 2, send, showKeyHints: true });
  root.append(keyboard.el);
  return { el: root, flash: keyboard.flash, dispose: keyboard.dispose };
}

function buildKeys(send: Send): InstrumentView {
  const root = el("div", "instrument keys");

  const patchRow = el("div", "patch-row");
  patchRow.append(el("span", "patch-label", "Patch:"));
  KEYS_PATCHES.forEach((name, index) => {
    const button = el("button", index === 0 ? "chip active" : "chip", name);
    button.addEventListener("click", () => {
      patchRow.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      button.classList.add("active");
      send({ t: "patch", patch: index });
    });
    patchRow.append(button);
  });
  root.append(patchRow);
  root.append(el("p", "hint", "Three octaves starting from C3. Up/Down arrows shift the octave."));

  const keyboard = buildKeyboard({ lowNote: 48, octaves: 3, send, showKeyHints: true });
  root.append(keyboard.el);
  return { el: root, flash: keyboard.flash, dispose: keyboard.dispose };
}

// ---------------------------------------------------------------------------
// Guitar
// ---------------------------------------------------------------------------

const CHORD_ROOTS: { name: string; root: number }[] = [
  { name: "E", root: 40 },
  { name: "A", root: 45 },
  { name: "D", root: 50 },
  { name: "G", root: 43 },
  { name: "C", root: 48 },
  { name: "F", root: 41 },
];

type Quality = "dur" | "moll" | "power";

/** Rough voicings rather than exact fingerings – sounds good on the string model. */
function voicing(root: number, quality: Quality): number[] {
  switch (quality) {
    case "power":
      return [root, root + 7, root + 12];
    case "moll":
      return [root, root + 7, root + 12, root + 15, root + 19];
    default:
      return [root, root + 7, root + 12, root + 16, root + 19];
  }
}

function buildGuitar(send: Send): InstrumentView {
  const root = el("div", "instrument guitar");
  root.append(
    el("p", "hint", "Choose chord, then strum: Space (down) / Shift+Space (up)."),
  );

  let quality: Quality = "dur";
  let chordRoot = CHORD_ROOTS[0]!.root;
  let chordName = "E";

  const strumBar = el("button", "strum-bar");
  const updateLabel = () => {
    strumBar.textContent = `Strum · ${chordName} ${quality}`;
  };

  const qualityRow = el("div", "patch-row");
  qualityRow.append(el("span", "patch-label", "Form:"));
  (["dur", "moll", "power"] as Quality[]).forEach((q) => {
    const button = el("button", q === "dur" ? "chip active" : "chip", q);
    button.addEventListener("click", () => {
      quality = q;
      qualityRow.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      button.classList.add("active");
      updateLabel();
    });
    qualityRow.append(button);
  });
  root.append(qualityRow);

  const chordGrid = el("div", "chord-grid");
  CHORD_ROOTS.forEach((chord, index) => {
    const button = el("button", index === 0 ? "chord active" : "chord", chord.name);
    button.addEventListener("click", () => {
      chordRoot = chord.root;
      chordName = chord.name;
      chordGrid.querySelectorAll(".chord").forEach((c) => c.classList.remove("active"));
      button.classList.add("active");
      updateLabel();
    });
    chordGrid.append(button);
  });
  root.append(chordGrid);

  updateLabel();
  const doStrum = (down: boolean) => {
    send({ t: "strum", notes: voicing(chordRoot, quality), vel: DEFAULT_VELOCITY, down });
    strumBar.classList.add("pressed");
    setTimeout(() => strumBar.classList.remove("pressed"), 90);
  };
  strumBar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    doStrum(!event.shiftKey);
  });
  root.append(strumBar);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.repeat || event.metaKey || event.ctrlKey) return;
    if (event.code === "Space") {
      event.preventDefault();
      doStrum(!event.shiftKey);
      return;
    }
    const index = Number(event.key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < CHORD_ROOTS.length) {
      const chord = CHORD_ROOTS[index]!;
      chordRoot = chord.root;
      chordName = chord.name;
      chordGrid.querySelectorAll(".chord").forEach((c, i) => {
        c.classList.toggle("active", i === index);
      });
      updateLabel();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  return {
    el: root,
    flash() {
      strumBar.classList.add("fired");
      setTimeout(() => strumBar.classList.remove("fired"), 130);
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
    },
  };
}

export function buildInstrument(role: Role, send: Send): InstrumentView {
  switch (role) {
    case "drums":
      return buildDrums(send);
    case "bass":
      return buildBass(send);
    case "guitar":
      return buildGuitar(send);
    case "keys":
      return buildKeys(send);
  }
}
