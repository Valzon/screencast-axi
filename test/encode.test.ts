import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode, DEFAULT_ENCODE_SETTINGS } from "../src/encode.js";
import {
  choosePosterEncoder,
  detectToolchain,
  installHint,
  runOrThrow,
  type Toolchain,
} from "../src/toolchain.js";

/**
 * The poster cascade exists because "does ffmpeg have libwebp" varies by
 * build - Homebrew's does not - and a missing optimisation must never fail a
 * recording. All three branches are asserted here rather than left to whatever
 * the machine running the suite happens to have.
 */
describe("poster encoder cascade", () => {
  it("prefers ffmpeg when the build has libwebp", () => {
    expect(choosePosterEncoder(true, true)).toBe("ffmpeg");
    expect(choosePosterEncoder(true, false)).toBe("ffmpeg");
  });

  it("falls back to cwebp when ffmpeg cannot write webp", () => {
    expect(choosePosterEncoder(false, true)).toBe("cwebp");
  });

  it("falls back to PNG rather than failing when neither can", () => {
    expect(choosePosterEncoder(false, false)).toBe("png");
  });
});

describe("install hints", () => {
  it("names a real package for this platform", () => {
    expect(installHint("ffmpeg")).toMatch(/ffmpeg|FFmpeg/);
    expect(installHint("cwebp")).toMatch(/webp|WebP/);
  });
});

describe("encoding a real capture", () => {
  let toolchain: Toolchain;
  let dir: string;
  let input: string;

  beforeAll(async () => {
    toolchain = await detectToolchain();
    dir = await mkdtemp(join(tmpdir(), "screencast-axi-"));
    input = join(dir, "raw.webm");
    if (toolchain.ffmpeg) {
      // Stand-in for a Playwright capture: VP8 webm, which is what it writes.
      await runOrThrow(toolchain.ffmpeg.path, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x400:rate=10:duration=2",
        "-c:v",
        "libvpx",
        "-b:v",
        "400k",
        input,
      ]);
    }
  }, 120_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("produces mp4, webm and a poster", async () => {
    if (!toolchain.ffmpeg) {
      // Reported rather than silently green: a machine without ffmpeg cannot
      // prove this, and pretending otherwise would hide a real regression.
      console.warn("skipped: ffmpeg not available on this machine");
      return;
    }
    const outDir = join(dir, "out");
    const result = await encode({
      ...DEFAULT_ENCODE_SETTINGS,
      width: 320,
      fps: 10,
      input,
      outDir,
      id: "sample",
      trimStart: 0.5,
      toolchain,
    });

    expect(result.mp4).toBe(join(outDir, "sample.mp4"));
    expect(result.webm).toBe(join(outDir, "sample.webm"));
    expect(result.posterEncoder).toBe(toolchain.posterEncoder);

    for (const file of [result.mp4, result.webm, result.poster]) {
      expect((await stat(file)).size).toBeGreaterThan(0);
    }

    // The poster extension has to follow the route actually taken, otherwise a
    // consumer resolving `<id>.webp` gets a 404 on a PNG-fallback machine.
    expect(result.poster.endsWith(toolchain.posterEncoder === "png" ? ".png" : ".webp")).toBe(true);

    // Real container magic, not just a non-empty file.
    const mp4Head = await readFile(result.mp4);
    expect(mp4Head.subarray(4, 8).toString("ascii")).toBe("ftyp");

    expect(Object.keys(result.sizes).sort()).toEqual(
      [
        "sample.mp4",
        "sample.webm",
        `sample.${toolchain.posterEncoder === "png" ? "png" : "webp"}`,
      ].sort(),
    );
    expect(result.gif).toBeUndefined();
  }, 180_000);
});
