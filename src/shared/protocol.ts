/**
 * Wire protocol between client and server.
 *
 * Control messages travel as JSON text over the WebSocket, the mixed audio
 * stream as binary frames (interleaved int16 PCM) over that same socket. A
 * client tells the two apart by `typeof event.data`.
 */

/** Sample rate of the server mix. The client opens its AudioContext at the same rate where it can. */
export const SAMPLE_RATE = 24_000;
/** The mix is stereo so the four tracks can be separated in the stereo field. */
export const CHANNELS = 2;
/** Resolution of the quantization grid: 4 = quarters, 16 = sixteenths. */
export const GRID_DIVISIONS = [4, 8, 16] as const;

export const ROLES = ["drums", "bass", "guitar", "keys"] as const;
export type Role = (typeof ROLES)[number];
/** Listeners without an instrument – any number of them. */
export type Seat = Role | "audience";

/** Order = track index in the Rust engine. Do not reorder. */
export const TRACK_OF: Record<Role, number> = {
  drums: 0,
  bass: 1,
  guitar: 2,
  keys: 3,
};

export const ROLE_LABEL: Record<Seat, string> = {
  drums: "Drums",
  bass: "Bass",
  guitar: "Gitarre",
  keys: "Keys/Synth",
  audience: "Publikum",
};

/** Drum pads: MIDI-like note numbers that the engine maps onto percussion. */
export const DRUM_NOTES = {
  kick: 36,
  snare: 38,
  hihat: 42,
  openhat: 46,
  tomLow: 45,
  tomHigh: 48,
  crash: 49,
} as const;

/** Keys patches; the index matches the engine's patch parameter. */
export const KEYS_PATCHES = ["Lead", "Pad", "Arpeggio"] as const;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/**
 * Room and player name arrive as query parameters of the WebSocket URL
 * (`/ws?room=…&name=…`), which is why there is no separate join message.
 */
export type ClientMessage =
  /** Claim a role. If it is taken, the server answers with `error`. */
  | { t: "claim"; role: Role }
  | { t: "release" }
  /** A single note. `on: false` is the note off. */
  | { t: "note"; note: number; vel: number; on: boolean }
  /** Guitar stroke: several strings that the server plucks staggered in time. */
  | { t: "strum"; notes: number[]; vel: number; down: boolean }
  | { t: "transport"; bpm?: number; playing?: boolean; grid?: number }
  | { t: "patch"; patch: number }
  | { t: "gain"; role: Role; gain: number }
  /** Store the running session under a name. */
  | { t: "save"; title: string }
  /** Play a saved song back, starting at the next bar. */
  | { t: "play"; songId: number }
  | { t: "clear" };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export interface PlayerInfo {
  id: string;
  name: string;
  seat: Seat;
}

export interface TransportState {
  bpm: number;
  playing: boolean;
  /** Denominator of the grid, e.g. 16 for sixteenths. */
  grid: number;
}

export interface RoomState {
  room: string;
  players: PlayerInfo[];
  transport: TransportState;
  /** Current patch per role (only keys uses it at the moment). */
  patches: Record<Role, number>;
  gains: Record<Role, number>;
}

export interface SongInfo {
  id: number;
  title: string;
  bpm: number;
  events: number;
  createdAt: number;
}

export type ServerMessage =
  | { t: "welcome"; you: PlayerInfo; state: RoomState; sampleRate: number; channels: number }
  | { t: "state"; state: RoomState }
  /**
   * Pulse for the visual click display. `beat` counts from 0 within the bar,
   * `at` is the sample position in the stream – the client shows the pulse only
   * once its playback reaches that point.
   */
  | { t: "tick"; bar: number; beat: number; at: number }
  /** The quantized event the engine actually plays – for UI feedback. */
  | { t: "fired"; role: Role; note: number; vel: number; at: number }
  /** Levels for the VU display: four tracks + master. */
  | { t: "peaks"; v: number[] }
  | { t: "songs"; songs: SongInfo[] }
  | { t: "error"; msg: string };

/** Samples per beat at a given BPM. */
export function samplesPerBeat(bpm: number): number {
  return (60 / bpm) * SAMPLE_RATE;
}

/** Samples per grid step (grid = 16 → sixteenths). */
export function samplesPerStep(bpm: number, grid: number): number {
  return samplesPerBeat(bpm) * (4 / grid);
}
