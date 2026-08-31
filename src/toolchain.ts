import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Locating the external encoders, and deciding how to make a poster.
 *
 * ffmpeg is not bundled: it is 80MB+ per platform, and *which* build you have
 * matters. Many common builds (Homebrew's among them) ship without libwebp, so
 * a package that bundled one would hide that difference rather than solve it.
 * Instead the poster has a fallback chain, and this module is the single place
 * that knows what is actually available.
 */

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawns `bin`, capturing both streams. Never throws on a non-zero exit. */
export function run(bin: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Spawns `bin` and throws with the tail of stderr when it fails. */
export async function runOrThrow(bin: string, args: readonly string[]): Promise<void> {
  const result = await run(bin, args);
  if (result.code !== 0) {
    const tail = result.stderr.split("\n").slice(-25).join("\n");
    throw new Error(`${bin} exited ${result.code}\n${tail}`);
  }
}

export interface BinaryInfo {
  readonly path: string;
  readonly version: string;
  /** Where it came from, for `doctor` to report. */
  readonly source: "env" | "ffmpeg-static" | "path";
}

const FFMPEG_ENV = "SCREENCAST_FFMPEG";
const CWEBP_ENV = "SCREENCAST_CWEBP";

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

async function probe(bin: string, source: BinaryInfo["source"]): Promise<BinaryInfo | null> {
  try {
    const result = await run(bin, ["-version"]);
    if (result.code !== 0) return null;
    return { path: bin, version: firstLine(result.stdout || result.stderr), source };
  } catch {
    return null;
  }
}

/**
 * ffmpeg, by the documented cascade: an explicit override, then an installed
 * `ffmpeg-static`, then PATH.
 *
 * `ffmpeg-static` is not a dependency - it is the escape hatch for someone who
 * would rather not install ffmpeg system-wide, and it is found only if they
 * chose to add it.
 */
export async function resolveFfmpeg(): Promise<BinaryInfo | null> {
  const override = process.env[FFMPEG_ENV];
  if (override) return probe(override, "env");

  try {
    // Computed specifier on purpose: this package is deliberately absent
    // unless someone opted into it, so TypeScript must not try to resolve it.
    const specifier = "ffmpeg-static";
    const mod = (await import(specifier)) as { default?: unknown };
    const bundled = typeof mod.default === "string" ? mod.default : null;
    if (bundled) {
      const found = await probe(bundled, "ffmpeg-static");
      if (found) return found;
    }
  } catch {
    // Not installed. Expected: it is an opt-in convenience, not a dependency.
  }

  return probe("ffmpeg", "path");
}

export async function resolveCwebp(): Promise<BinaryInfo | null> {
  const override = process.env[CWEBP_ENV];
  return probe(override ?? "cwebp", override ? "env" : "path");
}

/** Whether this ffmpeg build can write WebP itself. */
export async function ffmpegSupportsWebp(ffmpeg: string): Promise<boolean> {
  try {
    const result = await run(ffmpeg, ["-hide_banner", "-encoders"]);
    return result.code === 0 && /\blibwebp\b/.test(result.stdout);
  } catch {
    return false;
  }
}

/**
 * How to produce the poster image, best first.
 *
 * - `ffmpeg`: the build has libwebp, so one process does it.
 * - `cwebp`:  extract a PNG frame, then convert. What Homebrew needs.
 * - `png`:    neither is available. Larger, still a valid poster - a missing
 *             optimisation should not fail a recording.
 */
export type PosterEncoder = "ffmpeg" | "cwebp" | "png";

export interface Toolchain {
  readonly ffmpeg: BinaryInfo | null;
  readonly cwebp: BinaryInfo | null;
  readonly posterEncoder: PosterEncoder;
}

/**
 * The poster route, given what is available. Pure, so the three branches can
 * be tested without a machine that happens to have the right binaries.
 */
export function choosePosterEncoder(ffmpegHasWebp: boolean, hasCwebp: boolean): PosterEncoder {
  if (ffmpegHasWebp) return "ffmpeg";
  if (hasCwebp) return "cwebp";
  return "png";
}

export async function detectToolchain(): Promise<Toolchain> {
  const ffmpeg = await resolveFfmpeg();
  const cwebp = await resolveCwebp();
  const ffmpegHasWebp = ffmpeg !== null && (await ffmpegSupportsWebp(ffmpeg.path));
  return { ffmpeg, cwebp, posterEncoder: choosePosterEncoder(ffmpegHasWebp, cwebp !== null) };
}

/** Platform-appropriate install line, so an error is fixable in one step. */
export function installHint(tool: "ffmpeg" | "cwebp"): string {
  const pkg = tool === "ffmpeg" ? "ffmpeg" : "webp";
  switch (platform()) {
    case "darwin":
      return `brew install ${pkg}`;
    case "win32":
      return tool === "ffmpeg"
        ? "winget install --id Gyan.FFmpeg"
        : "winget install --id Google.WebP";
    default:
      return `sudo apt-get install ${pkg}`;
  }
}

export function missingFfmpegError(): Error {
  return new Error(
    `ffmpeg was not found. Install it with \`${installHint("ffmpeg")}\`, ` +
      `add \`ffmpeg-static\` as a dev dependency, or point ${FFMPEG_ENV} at a binary.`,
  );
}
