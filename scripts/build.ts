/**
 * Builds the single binary.
 *
 * `bun build --compile` packs the server, the bundled frontend (via the HTML
 * import), and the Bun runtime into one file. The target system does not need
 * Bun installed.
 *
 * What is *not* baked in is the Rust cdylib: it is loaded at runtime via
 * `dlopen` and therefore copied next to the binary.
 *
 * Usage:
 *   bun run scripts/build.ts                      # for this platform
 *   bun run scripts/build.ts --target=bun-linux-x64
 */

import { existsSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const CARGO_OUT = join(ROOT, "native/garage-synth/target/release");

const targetArg = process.argv.find((a) => a.startsWith("--target="));
const target = targetArg?.slice("--target=".length);

/** File name of the cdylib on the given platform. */
function libNameFor(platform: string): string {
  if (platform.includes("windows")) return "garage_synth.dll";
  if (platform.includes("darwin")) return "libgarage_synth.dylib";
  return "libgarage_synth.so";
}

const hostPlatform = process.platform === "win32" ? "windows" : process.platform;
const outPlatform = target ?? hostPlatform;
const exeSuffix = outPlatform.includes("windows") ? ".exe" : "";
const outfile = join(DIST, `garage-bund${exeSuffix}`);

await mkdir(DIST, { recursive: true });

// --- 1. Build the binary --------------------------------------------------

const buildArgs = [
  "bun",
  "build",
  "--compile",
  "src/server/index.ts",
  "--outfile",
  outfile,
];
if (target) buildArgs.push(`--target=${target}`);

console.log(`> ${buildArgs.join(" ")}`);
const build = Bun.spawnSync(buildArgs, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) {
  console.error("bun build failed");
  process.exit(build.exitCode ?? 1);
}

// --- 2. Place the audio engine next to it ---------------------------------

const libName = libNameFor(hostPlatform);
const libSource = join(CARGO_OUT, libName);

if (!existsSync(libSource)) {
  console.error(
    `\nAudio-Engine missing: ${libSource}\nBuild it with: bun run build:native`,
  );
  process.exit(1);
}

if (target && !target.includes(hostPlatform)) {
  console.warn(
    `\nCation: target is ${target}, the engine copied is build for ${hostPlatform}.\n` +
      `Run "cargo build --release" on the target machine and place ${libNameFor(target)} next to the binary.`,
  );
}

await copyFile(libSource, join(DIST, libName));

console.log(`\nReady:`);
console.log(`  ${outfile}`);
console.log(`  ${join(DIST, libName)}`);
console.log(`\nStart with: ${basename(outfile)}   (Engine is expected next to the binary)`);
