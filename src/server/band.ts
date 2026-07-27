/**
 * One band room: role assignment, the shared clock, quantization, and the one
 * mixed audio stream that every participant receives identically.
 */

import {
  ROLES,
  SAMPLE_RATE,
  TRACK_OF,
  type PlayerInfo,
  type Role,
  type RoomState,
  type Seat,
  type ServerMessage,
} from "../shared/protocol";
import { AudioEngine, CHUNK_FRAMES, RenderLoop } from "./audio";
import type { RecordedEvent, Store } from "./db";
import { KIND_NOTE_OFF, KIND_NOTE_ON } from "./ffi";
import { BEATS_PER_BAR, Transport } from "./transport";

/** Offset between the strings of one stroke – turns a chord into a strum. */
const STRUM_SPREAD_MS = 14;
/** How often peak values go out, counted in 20 ms chunks. */
const PEAK_EVERY_CHUNKS = 5;
/** How often recorded events are written to the database. */
const FLUSH_INTERVAL_MS = 1000;

export interface Player {
  id: string;
  name: string;
  seat: Seat;
}

/** Text = control message, binary frame = a stereo PCM chunk with a position header. */
type Publish = (data: string | Uint8Array<ArrayBuffer>) => void;

export class Band {
  readonly engine = new AudioEngine(SAMPLE_RATE);
  readonly transport = new Transport(SAMPLE_RATE);
  private readonly loop: RenderLoop;

  readonly players = new Map<string, Player>();
  private readonly seats = new Map<Role, string>();
  private readonly patches: Record<Role, number> = { drums: 0, bass: 0, guitar: 0, keys: 0 };
  private readonly gains: Record<Role, number> = { drums: 0.9, bass: 0.9, guitar: 0.85, keys: 0.8 };

  /** Sample position of the most recently scheduled note on, keyed by `track:note`. */
  private readonly noteOnAt = new Map<string, number>();
  /** Last guitar chord played, so the next strum can damp it. */
  private lastChord: number[] = [];

  private sessionId: number;
  private pendingEvents: RecordedEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private chunkCount = 0;
  private lastTickBeat = -1;

  constructor(
    readonly room: string,
    private readonly store: Store,
    private readonly publish: Publish,
  ) {
    this.sessionId = store.createSession(room, this.transport.bpm);
    this.loop = new RenderLoop({
      engine: this.engine,
      onChunk: (pcm, endSample) => this.onChunk(pcm, endSample),
    });
  }

  // -------------------------------------------------------------------------
  // Participants and roles
  // -------------------------------------------------------------------------

  join(id: string, name: string): Player {
    const player: Player = { id, name: name.trim() || "Gast", seat: "audience" };
    this.players.set(id, player);
    this.ensureRunning();
    return player;
  }

  leave(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    if (player.seat !== "audience") this.vacate(player.seat);
    this.players.delete(id);
    if (this.players.size === 0) this.idle();
  }

  /** Returns an error message if the role is already taken, `null` on success. */
  claim(id: string, role: Role): string | null {
    const player = this.players.get(id);
    if (!player) return "Unbekannter Spieler";
    const holder = this.seats.get(role);
    if (holder && holder !== id) {
      return `${role} ist schon besetzt`;
    }
    if (player.seat !== "audience") this.vacate(player.seat);
    this.seats.set(role, id);
    player.seat = role;
    return null;
  }

  release(id: string): void {
    const player = this.players.get(id);
    if (!player || player.seat === "audience") return;
    this.vacate(player.seat);
    player.seat = "audience";
  }

  private vacate(role: Role): void {
    this.seats.delete(role);
    // End the role's hanging notes, otherwise they sound forever.
    const track = TRACK_OF[role];
    for (const key of [...this.noteOnAt.keys()]) {
      if (key.startsWith(`${track}:`)) {
        const note = Number(key.slice(key.indexOf(":") + 1));
        this.engine.schedule(this.engine.samplePosition, track, KIND_NOTE_OFF, note, 0);
        this.noteOnAt.delete(key);
      }
    }
  }

  roleOf(id: string): Role | null {
    const seat = this.players.get(id)?.seat;
    return seat && seat !== "audience" ? seat : null;
  }

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------

  /**
   * The core of the timing logic: the event is not played immediately but
   * placed on the next grid position. Network jitter drops out of the picture –
   * two players whose packets arrive 40 ms apart land on the same sixteenth.
   */
  note(id: string, note: number, vel: number, on: boolean): void {
    const role = this.roleOf(id);
    if (!role) return;
    const track = TRACK_OF[role];
    const key = `${track}:${note}`;

    if (on) {
      const q = this.transport.quantize(this.engine.samplePosition);
      this.engine.schedule(q.sample, track, KIND_NOTE_ON, note, clamp01(vel));
      this.noteOnAt.set(key, q.sample);
      this.record({ beat: q.beat, track, kind: KIND_NOTE_ON, note, vel: clamp01(vel) });
      this.send({ t: "fired", role, note, vel: clamp01(vel), at: q.sample });
      return;
    }

    // Note off goes on the grid too, but never before its own note on.
    const q = this.transport.quantize(this.engine.samplePosition);
    const onAt = this.noteOnAt.get(key);
    let at = q.sample;
    let beat = q.beat;
    if (onAt !== undefined && at <= onAt) {
      const stepSamples = this.transport.stepBeats * this.transport.samplesPerBeat;
      at = onAt + stepSamples;
      beat = this.transport.beatAt(at);
    }
    this.engine.schedule(at, track, KIND_NOTE_OFF, note, 0);
    this.noteOnAt.delete(key);
    this.record({ beat, track, kind: KIND_NOTE_OFF, note, vel: 0 });
  }

  /**
   * Guitar stroke: the strings are plucked slightly staggered – low to high on
   * a downstroke, the other way round on an upstroke.
   */
  strum(id: string, notes: number[], vel: number, down: boolean): void {
    const role = this.roleOf(id);
    if (role !== "guitar" || notes.length === 0) return;
    const track = TRACK_OF.guitar;
    const q = this.transport.quantize(this.engine.samplePosition);
    const spread = (STRUM_SPREAD_MS / 1000) * SAMPLE_RATE;
    const ordered = down ? [...notes].sort((a, b) => a - b) : [...notes].sort((a, b) => b - a);

    for (const prev of this.lastChord) {
      this.engine.schedule(q.sample, track, KIND_NOTE_OFF, prev, 0);
    }
    this.record({ beat: q.beat, track, kind: KIND_NOTE_OFF, note: -1, vel: 0 });

    ordered.forEach((note, i) => {
      const at = q.sample + i * spread;
      // Strings further into the stroke come out a little quieter.
      const v = clamp01(vel * (1 - i * 0.04));
      this.engine.schedule(at, track, KIND_NOTE_ON, note, v);
      this.record({ beat: this.transport.beatAt(at), track, kind: KIND_NOTE_ON, note, vel: v });
    });

    this.lastChord = ordered;
    this.send({ t: "fired", role, note: ordered[0]!, vel: clamp01(vel), at: q.sample });
  }

  // -------------------------------------------------------------------------
  // Transport, patches, levels
  // -------------------------------------------------------------------------

  setTransport(opts: { bpm?: number; playing?: boolean; grid?: number }): void {
    if (typeof opts.bpm === "number" && Number.isFinite(opts.bpm)) {
      this.transport.setBpm(opts.bpm, this.engine.samplePosition);
    }
    if (typeof opts.grid === "number" && [4, 8, 16].includes(opts.grid)) {
      this.transport.grid = opts.grid;
    }
    if (typeof opts.playing === "boolean") {
      this.transport.playing = opts.playing;
      if (!opts.playing) this.allNotesOff();
    }
  }

  setPatch(id: string, patch: number): void {
    const role = this.roleOf(id);
    if (!role) return;
    const p = Math.max(0, Math.min(2, Math.floor(patch)));
    this.patches[role] = p;
    this.engine.setPatch(TRACK_OF[role], p);
  }

  setGain(role: Role, gain: number): void {
    const g = Math.max(0, Math.min(1.5, gain));
    this.gains[role] = g;
    this.engine.setGain(TRACK_OF[role], g);
  }

  allNotesOff(): void {
    this.engine.panic();
    this.noteOnAt.clear();
    this.lastChord = [];
  }

  // -------------------------------------------------------------------------
  // Recording and songs
  // -------------------------------------------------------------------------

  private record(event: RecordedEvent): void {
    this.pendingEvents.push(event);
  }

  private flush(): void {
    if (this.pendingEvents.length === 0) return;
    const batch = this.pendingEvents;
    this.pendingEvents = [];
    this.store.appendEvents(this.sessionId, batch);
  }

  save(title: string): void {
    this.flush();
    this.store.saveSession(this.sessionId, title.trim() || "Ohne Titel", this.transport.bpm);
    this.sendSongs();
  }

  /** Starts a fresh recording; what came before stays around as its own session. */
  clear(): void {
    this.flush();
    this.allNotesOff();
    this.sessionId = this.store.createSession(this.room, this.transport.bpm);
  }

  /** Plays a saved song back, starting at the next bar line. */
  play(songId: number): string | null {
    const song = this.store.getSong(songId);
    if (!song) return "Song nicht gefunden";
    const events = this.store.loadEvents(songId);
    if (events.length === 0) return "Song enthält keine Events";

    const nowBeat = this.transport.beatAt(this.engine.samplePosition);
    const startBeat = Math.ceil(nowBeat / BEATS_PER_BAR) * BEATS_PER_BAR;
    // Normalize against the song's own bar line so its internal bar position
    // is preserved.
    const base = Math.floor(events[0]!.beat / BEATS_PER_BAR) * BEATS_PER_BAR;

    for (const e of events) {
      if (e.note < 0) continue; // placeholder left by strum damping
      const at = this.transport.sampleAtBeat(startBeat + (e.beat - base));
      this.engine.schedule(at, e.track, e.kind, e.note, e.vel);
    }
    return null;
  }

  sendSongs(): void {
    this.send({ t: "songs", songs: this.store.listSongs() });
  }

  // -------------------------------------------------------------------------
  // State and distribution
  // -------------------------------------------------------------------------

  state(): RoomState {
    const players: PlayerInfo[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
    }));
    return {
      room: this.room,
      players,
      transport: {
        bpm: this.transport.bpm,
        playing: this.transport.playing,
        grid: this.transport.grid,
      },
      patches: { ...this.patches },
      gains: { ...this.gains },
    };
  }

  send(msg: ServerMessage): void {
    this.publish(JSON.stringify(msg));
  }

  broadcastState(): void {
    this.send({ t: "state", state: this.state() });
  }

  // -------------------------------------------------------------------------
  // Audio loop
  // -------------------------------------------------------------------------

  private ensureRunning(): void {
    if (this.flushTimer) return;
    this.loop.start();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  private idle(): void {
    this.loop.stop();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    this.allNotesOff();
  }

  private onChunk(frame: Uint8Array<ArrayBuffer>, endSample: number): void {
    // Exactly one publish() per chunk – Bun fans it out to every subscriber of
    // the topic. This is the heart of the whole thing: one stream, everybody
    // hears the same, no drift between players.
    this.publish(frame);

    this.chunkCount++;
    if (this.chunkCount % PEAK_EVERY_CHUNKS === 0) {
      const p = this.engine.peaks();
      this.send({ t: "peaks", v: [p[0]!, p[1]!, p[2]!, p[3]!, p[4]!] });
    }

    if (this.transport.playing) {
      // Announce beat boundaries falling inside this chunk as click events.
      const startSample = endSample - CHUNK_FRAMES;
      const firstBeat = Math.ceil(this.transport.beatAt(startSample));
      const lastBeat = Math.floor(this.transport.beatAt(endSample));
      for (let b = firstBeat; b <= lastBeat; b++) {
        if (b === this.lastTickBeat) continue;
        this.lastTickBeat = b;
        const at = this.transport.sampleAtBeat(b);
        this.send({
          t: "tick",
          bar: Math.floor(b / BEATS_PER_BAR),
          beat: ((b % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR,
          at,
        });
      }
    }
  }

  dispose(): void {
    this.idle();
    this.engine.free();
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.8;
}

export { ROLES };
