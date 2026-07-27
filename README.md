# Bun Fuzz

Collaborative band-jam app: several people connect to a room, each one
takes an instrument, and everyone hears exactly the same sound — because
the server generates the sound, not the browser.

The actual problem the app solves: if every client synthesizes audio
itself, the clocks drift apart, and after a few seconds nobody's in time
anymore. Here, the server dictates both tempo *and* sound, quantizes
incoming notes against its own grid, and sends a single mixed stream back
to everyone.

## Requirements

- [Bun](https://bun.com) ≥ 1.3
- [Rust](https://rustup.rs) (for the audio engine)

## Getting started

```bash
bun install
bun run build:native   # builds the Rust engine (cdylib)
bun run dev            # starts server + frontend on http://localhost:3000
```

Open the browser, enter a name, grab a role, start playing. For a real
session, just send several people to the same URL — the room lives in the
query parameter (`?room=garage`).

## The four roles

| Role | Controls |
|---|---|
| **Drums** | Pad grid, keys `A S D F` and `J K L` |
| **Bass** | Two octaves from E1, key row `A W S E D …` |
| **Guitar** | Pick a chord (keys `1`–`6`), strum with spacebar (`Shift` = upstroke) |
| **Keys** | Three octaves, three patches (Lead / Pad / Arpeggio) |

Up/down arrow keys shift the octave for Bass and Keys. Anyone who doesn't
take a role is part of the audience and just listens.

## Scripts

```bash
bun run dev            # development with hot reload
bun run start           # server without hot reload
bun run build:native    # only the Rust engine
bun run build           # engine + single binary into dist/
bun test                # unit tests for engine, transport, WAV
bun run smoke           # end-to-end against an actually running server
bun run typecheck       # tsc --noEmit
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `GARAGE_DB` | `garage.sqlite` | Path to the SQLite file |
| `GARAGE_SYNTH_LIB` | – | Path to the audio engine, if it lives elsewhere |

## Songs and export

Everything that's played lands as a quantized event in `bun:sqlite`. The
songs panel lets you name a session, play it back later, or download it
as a WAV (`/api/export/:id`). The export renders the song offline through
the same Rust engine it was played live with.

## Structure

```
src/shared/     Protocol between client and server
src/server/     Bun.serve, room logic, transport, FFI binding, SQLite
src/client/     Frontend, bundled by Bun via HTML import
native/         Rust crate for the audio engine
```
