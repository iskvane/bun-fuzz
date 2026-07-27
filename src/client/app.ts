/**
 * Client logic: connection, room state, role selection, and mounting the
 * matching instrument view.
 */

import "./styles.css";
import {
  CHANNELS,
  ROLES,
  ROLE_LABEL,
  SAMPLE_RATE,
  type ClientMessage,
  type Role,
  type RoomState,
  type ServerMessage,
  type SongInfo,
} from "../shared/protocol";
import { buildInstrument, type InstrumentView } from "./instruments";
import { StreamPlayer } from "./player";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Element #${id} fehlt`);
  return node as T;
};

const player = new StreamPlayer();

let socket: WebSocket | null = null;
let myId = "";
let mySeat: Role | "audience" = "audience";
let instrument: InstrumentView | null = null;
let lastState: RoomState | null = null;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function send(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function connect(room: string, name: string): void {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${location.host}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`;
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => setStatus("connected", "ok"));
  socket.addEventListener("close", () => {
    setStatus("disconnected – reload", "bad");
  });
  socket.addEventListener("error", () => setStatus("Connection error", "bad"));

  socket.addEventListener("message", (event) => {
    // Binary frames are audio, text is control.
    if (event.data instanceof ArrayBuffer) {
      player.push(event.data);
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      return;
    }
    handle(msg);
  });
}

function handle(msg: ServerMessage): void {
  switch (msg.t) {
    case "welcome":
      myId = msg.you.id;
      applyState(msg.state);
      break;

    case "state":
      applyState(msg.state);
      break;

    case "tick":
      // Only show it once playback has reached this point.
      afterPlayback(msg.at, () => showBeat(msg.beat));
      break;

    case "fired":
      if (msg.role === mySeat) {
        afterPlayback(msg.at, () => instrument?.flash(msg.note));
      }
      break;

    case "peaks":
      updateMeters(msg.v);
      break;

    case "songs":
      renderSongs(msg.songs);
      break;

    case "error":
      setStatus(msg.msg, "bad");
      setTimeout(() => setStatus("connected", "ok"), 2500);
      break;
  }
}

/**
 * The server schedules events in the future. The display is delayed by exactly
 * the difference to our own playback position, so the pad flashes precisely
 * when the hit is audible.
 */
function afterPlayback(at: number, action: () => void): void {
  const delay = player.delayUntil(at);
  if (delay <= 0) action();
  else setTimeout(action, Math.min(delay, 4000));
}

// ---------------------------------------------------------------------------
// Rendering state
// ---------------------------------------------------------------------------

function applyState(state: RoomState): void {
  lastState = state;
  const me = state.players.find((p) => p.id === myId);
  const seat = me?.seat ?? "audience";

  if (seat !== mySeat) {
    mySeat = seat;
    mountInstrument();
  }

  renderRoles(state);
  renderPlayers(state);
  renderTransport(state);
  renderMixer(state);
}

function mountInstrument(): void {
  const stage = $("stage");
  instrument?.dispose();
  instrument = null;
  stage.replaceChildren();

  if (mySeat === "audience") {
    const note = document.createElement("p");
    note.className = "audience-note";
    note.textContent = "You are listening. Grab a free roles to play.";
    stage.append(note);
    return;
  }

  instrument = buildInstrument(mySeat, send);
  stage.append(instrument.el);
}

function renderRoles(state: RoomState): void {
  const container = $("roles");
  container.replaceChildren();

  for (const role of ROLES) {
    const holder = state.players.find((p) => p.seat === role);
    const mine = holder?.id === myId;
    const card = document.createElement("button");
    card.className = `role-card${mine ? " mine" : ""}${holder && !mine ? " taken" : ""}`;
    card.dataset.role = role;

    const title = document.createElement("strong");
    title.textContent = ROLE_LABEL[role];
    const who = document.createElement("span");
    who.className = "role-who";
    who.textContent = holder ? (mine ? "You" : holder.name) : "free";

    const meter = document.createElement("div");
    meter.className = "role-meter";
    const fill = document.createElement("div");
    fill.className = "role-meter-fill";
    fill.dataset.meter = role;
    meter.append(fill);

    card.append(title, who, meter);
    card.addEventListener("click", () => {
      if (mine) send({ t: "release" });
      else if (!holder) send({ t: "claim", role });
    });
    container.append(card);
  }
}

function renderPlayers(state: RoomState): void {
  const list = $("players-list");
  list.replaceChildren();
  for (const p of state.players) {
    const item = document.createElement("li");
    item.textContent = `${p.name} – ${ROLE_LABEL[p.seat]}`;
    if (p.id === myId) item.className = "me";
    list.append(item);
  }
}

function renderTransport(state: RoomState): void {
  const bpm = $<HTMLInputElement>("bpm");
  if (document.activeElement !== bpm) bpm.value = String(state.transport.bpm);
  $("bpm-value").textContent = `${Math.round(state.transport.bpm)} BPM`;

  const grid = $<HTMLSelectElement>("grid");
  if (document.activeElement !== grid) grid.value = String(state.transport.grid);

  const toggle = $<HTMLButtonElement>("play-toggle");
  toggle.textContent = state.transport.playing ? "Klick aus" : "Klick an";
  toggle.classList.toggle("active", state.transport.playing);
}

function renderMixer(state: RoomState): void {
  const mixer = $("mixer");
  if (mixer.childElementCount > 0) {
    // Only update the values, so dragging a slider doesn't get interrupted.
    for (const role of ROLES) {
      const input = mixer.querySelector<HTMLInputElement>(`input[data-role="${role}"]`);
      if (input && document.activeElement !== input) {
        input.value = String(state.gains[role]);
      }
    }
    return;
  }

  for (const role of ROLES) {
    const row = document.createElement("label");
    row.className = "mixer-row";
    const label = document.createElement("span");
    label.textContent = ROLE_LABEL[role];
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "1.5";
    input.step = "0.05";
    input.value = String(state.gains[role]);
    input.dataset.role = role;
    input.addEventListener("input", () => {
      send({ t: "gain", role, gain: Number(input.value) });
    });
    row.append(label, input);
    mixer.append(row);
  }
}

function renderSongs(songs: SongInfo[]): void {
  const list = $("songs-list");
  list.replaceChildren();

  if (songs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Noch nichts gespeichert.";
    list.append(empty);
    return;
  }

  for (const song of songs) {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "song-title";
    title.textContent = `${song.title} · ${song.events} Events`;

    const play = document.createElement("button");
    play.className = "mini";
    play.textContent = "play";
    play.addEventListener("click", () => send({ t: "play", songId: song.id }));

    const download = document.createElement("a");
    download.className = "mini";
    download.href = `/api/export/${song.id}`;
    download.textContent = "WAV";

    item.append(title, play, download);
    list.append(item);
  }
}

// ---------------------------------------------------------------------------
// Click display and levels
// ---------------------------------------------------------------------------

function showBeat(beat: number): void {
  const dots = $("beats").children;
  for (let i = 0; i < dots.length; i++) {
    dots[i]!.classList.toggle("on", i === beat);
  }
}

function updateMeters(values: number[]): void {
  ROLES.forEach((role, index) => {
    const fill = document.querySelector<HTMLElement>(`.role-meter-fill[data-meter="${role}"]`);
    if (fill) fill.style.width = `${Math.min(100, (values[index] ?? 0) * 100)}%`;
  });
  const master = $("master-fill");
  master.style.width = `${Math.min(100, (values[4] ?? 0) * 100)}%`;
}

function setStatus(text: string, kind: "ok" | "bad" | "idle"): void {
  const status = $("status");
  status.textContent = text;
  status.className = `status ${kind}`;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function setupControls(): void {
  $<HTMLInputElement>("bpm").addEventListener("input", (event) => {
    const bpm = Number((event.target as HTMLInputElement).value);
    $("bpm-value").textContent = `${bpm} BPM`;
    send({ t: "transport", bpm });
  });

  $<HTMLSelectElement>("grid").addEventListener("change", (event) => {
    send({ t: "transport", grid: Number((event.target as HTMLSelectElement).value) });
  });

  $("play-toggle").addEventListener("click", () => {
    send({ t: "transport", playing: !(lastState?.transport.playing ?? true) });
  });

  $("panic").addEventListener("click", () => send({ t: "clear" }));

  $("save").addEventListener("click", () => {
    const input = $<HTMLInputElement>("save-title");
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    send({ t: "save", title });
    input.value = "";
  });

  $<HTMLInputElement>("volume").addEventListener("input", (event) => {
    player.setVolume(Number((event.target as HTMLInputElement).value));
  });

  const beats = $("beats");
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement("span");
    dot.className = "beat-dot";
    beats.append(dot);
  }
}

async function enter(): Promise<void> {
  const name = $<HTMLInputElement>("name-input").value.trim() || "Gast";
  const room = $<HTMLInputElement>("room-input").value.trim() || "garage";

  // The AudioContext has to start from within the user gesture.
  await player.start(SAMPLE_RATE, CHANNELS);

  $("gate").hidden = true;
  $("main").hidden = false;
  $("room-name").textContent = room;
  setStatus("connecting…", "idle");
  connect(room, name);
}

function init(): void {
  setupControls();

  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  if (room) $<HTMLInputElement>("room-input").value = room;

  $("enter").addEventListener("click", () => {
    void enter();
  });
  $<HTMLInputElement>("name-input").addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void enter();
  });
}

init();
