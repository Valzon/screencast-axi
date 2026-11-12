import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureClockOffset, parseSyncMark } from "../src/sync.js";
import { detectToolchain, runOrThrow, type Toolchain } from "../src/toolchain.js";

/**
 * The recorder's clock and the video's start a fraction of a second apart,
 * and every time the recorder logs - the head-trim, a framed clip's captions -
 * is on the first. These pin down the measurement that reconciles them.
 */
describe("reading the sync mark", () => {
  const log = (rows: [number, number][]) =>
    rows.map(([t, y]) => `frame:0 pts:0 pts_time:${t}\nlavfi.signalstats.YAVG=${y}`).join("\n");

  it("finds the first grey frame", () => {
    expect(
      parseSyncMark(
        log([
          [0, 235],
          [0.04, 235],
          [0.6, 126.3],
          [0.64, 126.3],
        ]),
      ),
    ).toBe(0.6);
  });

  it("refuses a mark on the very first frame, which only says the video started late", () => {
    expect(
      parseSyncMark(
        log([
          [0, 126],
          [0.04, 126],
        ]),
      ),
    ).toBeNull();
  });

  it("returns nothing when there is no mark", () => {
    expect(
      parseSyncMark(
        log([
          [0, 235],
          [0.04, 16],
        ]),
      ),
    ).toBeNull();
  });
});

describe("measuring the offset on a real capture", () => {
  let toolchain: Toolchain;
  let dir: string;
  let input: string;

  beforeAll(async () => {
    toolchain = await detectToolchain();
    dir = await mkdtemp(join(tmpdir(), "screencast-axi-sync-"));
    input = join(dir, "raw.webm");
    if (toolchain.ffmpeg) {
      // White until 0.8s, then the mark's grey.
      await runOrThrow(toolchain.ffmpeg.path, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:size=160x90:rate=25:duration=0.8",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x808080:size=160x90:rate=25:duration=0.8",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1[v]",
        "-map",
        "[v]",
        "-c:v",
        "libvpx",
        input,
      ]);
    }
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("is where the mark appeared, less when it was logged", async () => {
    if (!toolchain.ffmpeg) {
      console.warn("skipped: ffmpeg not available on this machine");
      return;
    }
    // Logged at 1s on the recorder's clock, seen at 0.8s in the video: the
    // video started 0.2s after the recorder's clock did.
    const offset = await measureClockOffset(toolchain.ffmpeg.path, input, 1000);
    expect(offset).toBeCloseTo(-0.2, 2);
  });

  it("refuses an offset too large to be the mark", async () => {
    if (!toolchain.ffmpeg) return;
    expect(await measureClockOffset(toolchain.ffmpeg.path, input, 9000)).toBeNull();
  });
});
