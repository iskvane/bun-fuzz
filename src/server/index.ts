/**
 * Server entry point. A single `Bun.serve()` handles three things at once:
 * the bundled frontend (HTML import), the JSON API, and the WebSocket with
 * native pub/sub – no Express, no Socket.io, no Redis adapter.
 */

import type { Server, ServerWebSocket } from "bun";
import homepage from "../client/index.html";
import {
  CHANNELS,
  ROLES,
  SAMPLE_RATE,
  type ClientMessage,
  type Role,
} from "../shared/protocol";
import { Band } from "./band";
import { Store } from "./db";
import { renderSongToWav } from "./export";
import { LIB_PATH } from "./ffi";

interface WsData {
  id: string;
  room: string;
  name: string;
}

const store = new Store(process.env.GARAGE_DB ?? "garage.sqlite");
store.pruneEmptySessions();

const bands = new Map<string, Band>();
let server: Server<WsData>;

const topicOf = (room: string) => `band:${room}`;

function bandFor(room: string): Band {
  let band = bands.get(room);
  if (!band) {
    band = new Band(room, store, (data) => {
      server.publish(topicOf(room), data);
    });
    bands.set(room, band);
  }
  return band;
}

function sanitizeRoom(value: string | null): string {
  const room = (value ?? "garage").trim().toLowerCase().slice(0, 32);
  return /^[a-z0-9-]+$/.test(room) ? room : "garage";
}

server = Bun.serve<WsData, "/" | "/api/songs" | "/api/export/:id">({
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== "production",

  routes: {
    // Bun bundles the HTML along with its TypeScript and CSS – no Vite needed.
    "/": homepage,

    "/api/songs": {
      GET: () => Response.json(store.listSongs()),
    },

    "/api/export/:id": {
      GET: (req) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return new Response("Ungültige ID", { status: 400 });
        const wav = renderSongToWav(store, id);
        if (!wav) return new Response("Song nicht gefunden oder leer", { status: 404 });
        return new Response(new Blob([wav], { type: "audio/wav" }), {
          headers: {
            "content-disposition": `attachment; filename="garage-bund-${id}.wav"`,
          },
        });
      },
    },
  },

  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const room = sanitizeRoom(url.searchParams.get("room"));
      const name = (url.searchParams.get("name") ?? "Gast").trim().slice(0, 24);
      const ok = srv.upgrade(req, {
        data: { id: crypto.randomUUID(), room, name } satisfies WsData,
      });
      return ok ? undefined : new Response("Upgrade fehlgeschlagen", { status: 400 });
    }
    return new Response("Nicht gefunden", { status: 404 });
  },

  websocket: {
    perMessageDeflate: false,

    open(ws: ServerWebSocket<WsData>) {
      const { room, id, name } = ws.data;
      const band = bandFor(room);
      const player = band.join(id, name);
      ws.subscribe(topicOf(room));

      ws.send(
        JSON.stringify({
          t: "welcome",
          you: { id: player.id, name: player.name, seat: player.seat },
          state: band.state(),
          sampleRate: SAMPLE_RATE,
          channels: CHANNELS,
        }),
      );
      ws.send(JSON.stringify({ t: "songs", songs: store.listSongs() }));
      band.broadcastState();
    },

    message(ws: ServerWebSocket<WsData>, raw) {
      if (typeof raw !== "string") return;
      const band = bands.get(ws.data.room);
      if (!band) return;

      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw) as ClientMessage;
      } catch {
        return;
      }

      const id = ws.data.id;
      switch (msg.t) {
        case "claim": {
          if (!ROLES.includes(msg.role)) return;
          const err = band.claim(id, msg.role);
          if (err) {
            ws.send(JSON.stringify({ t: "error", msg: err }));
            return;
          }
          band.broadcastState();
          break;
        }

        case "release":
          band.release(id);
          band.broadcastState();
          break;

        case "note":
          if (typeof msg.note !== "number") return;
          band.note(id, msg.note | 0, Number(msg.vel), Boolean(msg.on));
          break;

        case "strum":
          if (!Array.isArray(msg.notes)) return;
          band.strum(
            id,
            msg.notes.filter((n) => typeof n === "number").map((n) => n | 0),
            Number(msg.vel),
            Boolean(msg.down),
          );
          break;

        case "transport":
          band.setTransport(msg);
          band.broadcastState();
          break;

        case "patch":
          band.setPatch(id, Number(msg.patch));
          band.broadcastState();
          break;

        case "gain":
          if (!ROLES.includes(msg.role as Role)) return;
          band.setGain(msg.role, Number(msg.gain));
          band.broadcastState();
          break;

        case "save":
          band.save(String(msg.title ?? ""));
          break;

        case "play": {
          const err = band.play(Number(msg.songId));
          if (err) ws.send(JSON.stringify({ t: "error", msg: err }));
          break;
        }

        case "clear":
          band.clear();
          break;
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      const band = bands.get(ws.data.room);
      if (!band) return;
      ws.unsubscribe(topicOf(ws.data.room));
      band.leave(ws.data.id);
      if (band.players.size === 0) {
        // Room is empty: free the engine instead of keeping it idling.
        band.dispose();
        bands.delete(ws.data.room);
      } else {
        band.broadcastState();
      }
    },
  },
});

console.log(`Garage Bund läuft auf ${server.url}`);
console.log(`Audio-Engine: ${LIB_PATH}`);
console.log(`Mix: ${SAMPLE_RATE} Hz, ${CHANNELS} Kanäle`);

function shutdown() {
  for (const band of bands.values()) band.dispose();
  bands.clear();
  store.close();
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
