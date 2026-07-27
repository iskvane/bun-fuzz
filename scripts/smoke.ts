/**
 * End-to-end test: starts the server, connects a real WebSocket client, plays a
 * few notes, and checks that audible audio actually comes back. Run it with
 * `bun run scripts/smoke.ts`.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3999;
const DB = join(tmpdir(), `garage-smoke-${Date.now()}.sqlite`);
const BASE = `http://localhost:${PORT}`;

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` – ${detail}` : ""}`);
  if (!ok) failures++;
}

const server = Bun.spawn(["bun", "src/server/index.ts"], {
  env: { ...process.env, PORT: String(PORT), GARAGE_DB: DB, NODE_ENV: "production" },
  stdout: "pipe",
  stderr: "inherit",
});

async function waitForServer(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/songs`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(120);
  }
  return false;
}

function cleanup(): void {
  server.kill();
  try {
    rmSync(DB, { force: true });
    rmSync(`${DB}-wal`, { force: true });
    rmSync(`${DB}-shm`, { force: true });
  } catch {
    // best effort
  }
}

try {
  if (!(await waitForServer())) {
    console.error("Server did not start 🤷‍♂️");
    cleanup();
    process.exit(1);
  }
  console.log(`Server running: ${BASE}\n`);

  const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=test&name=Smoke`);
  ws.binaryType = "arraybuffer";

  const messages: Record<string, number> = {};
  let audioFrames = 0;
  let audioBytes = 0;
  let peak = 0;
  let lastPos = -1;
  let positionsOutOfOrder = 0;
  let welcomed = false;
  let seat = "";

  ws.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      audioFrames++;
      audioBytes += event.data.byteLength;
      // 8-byte header with the sample position, then the PCM.
      const pos = new DataView(event.data).getFloat64(0, true);
      if (pos >= lastPos) lastPos = pos;
      else positionsOutOfOrder++;
      const pcm = new Int16Array(event.data, 8);
      for (const s of pcm) {
        const a = Math.abs(s);
        if (a > peak) peak = a;
      }
      return;
    }
    const msg = JSON.parse(event.data as string);
    messages[msg.t] = (messages[msg.t] ?? 0) + 1;
    if (msg.t === "welcome") welcomed = true;
    if (msg.t === "state") {
      const me = msg.state.players[0];
      if (me) seat = me.seat;
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WebSocket-Error")));
    setTimeout(() => reject(new Error("Timeout while connecting")), 5000);
  });

  await Bun.sleep(300);
  check("Welcome message received", welcomed);

  ws.send(JSON.stringify({ t: "claim", role: "drums" }));
  await Bun.sleep(200);
  check("Role drums claimed", seat === "drums", `seat=${seat}`);

  // One bar of eighth notes on kick and snare.
  for (let i = 0; i < 8; i++) {
    ws.send(
      JSON.stringify({ t: "note", note: i % 2 === 0 ? 36 : 38, vel: 0.9, on: true }),
    );
    await Bun.sleep(125);
  }
  await Bun.sleep(1200);

  check("Audio-Chunks received", audioFrames > 40, `${audioFrames} Chunks`);
  check(
    "Chunk size is correct (8 Byte header + 480 Frames stereo int16)",
    audioBytes / Math.max(1, audioFrames) === 1928,
    `${Math.round(audioBytes / Math.max(1, audioFrames))} Bytes`,
  );
  check("Sample-Positions run monoton", positionsOutOfOrder === 0);
  check("Audio is not silent", peak > 2000, `Peak ${peak}`);
  check("Click-Ticks received", (messages.tick ?? 0) > 2, `${messages.tick ?? 0} Ticks`);
  check("Level values received", (messages.peaks ?? 0) > 2, `${messages.peaks ?? 0} Packages`);
  check("Note-Feedback received", (messages.fired ?? 0) >= 8, `${messages.fired ?? 0} Events`);

  // A second client must not get the same role.
  const ws2 = new WebSocket(`ws://localhost:${PORT}/ws?room=test&name=Zweiter`);
  let rejected = false;
  ws2.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const msg = JSON.parse(event.data);
    if (msg.t === "error") rejected = true;
  });
  await new Promise<void>((resolve) => ws2.addEventListener("open", () => resolve()));
  ws2.send(JSON.stringify({ t: "claim", role: "drums" }));
  await Bun.sleep(300);
  check("Claimed role is rejected", rejected);

  // Save and export as WAV.
  ws.send(JSON.stringify({ t: "save", title: "Smoke-Test" }));
  await Bun.sleep(600);

  const songs = (await (await fetch(`${BASE}/api/songs`)).json()) as {
    id: number;
    title: string;
    events: number;
  }[];
  check("Song saved", songs.length === 1 && songs[0]!.title === "Smoke-Test");
  check("Events recorded", (songs[0]?.events ?? 0) >= 8, `${songs[0]?.events ?? 0} Events`);

  if (songs[0]) {
    const wavRes = await fetch(`${BASE}/api/export/${songs[0].id}`);
    const wav = new Uint8Array(await wavRes.arrayBuffer());
    const riff = new TextDecoder().decode(wav.subarray(0, 4));
    let wavPeak = 0;
    const samples = new Int16Array(wav.buffer, 44, (wav.length - 44) >> 1);
    for (const s of samples) wavPeak = Math.max(wavPeak, Math.abs(s));

    check("WAV-Export delivers RIFF", riff === "RIFF", riff);
    check("WAV-Export is not silent", wavPeak > 2000, `Peak ${wavPeak}`);
    check("WAV-Export has length", wav.length > 100_000, `${wav.length} Bytes`);
  }

  ws.close();
  ws2.close();
  await Bun.sleep(200);
} catch (error) {
  console.error("\nAbort:", error);
  failures++;
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nAll cheks green." : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
