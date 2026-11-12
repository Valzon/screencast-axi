import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { resolveConfig } from "../src/config.js";
import { Director } from "../src/director.js";
import {
  assertFrameSetting,
  captionCues,
  composeArgs,
  composeFrame,
  DEFAULT_FRAME_STYLE,
  FRAME_ENV,
  frameFromEnv,
  frameLayout,
  resolveFrame,
} from "../src/frame.js";
import { detectToolchain, run, runOrThrow, type Toolchain } from "../src/toolchain.js";

describe("whether a take is framed", () => {
  it("is off unless something turns it on", () => {
    expect(resolveFrame(undefined, undefined)).toBeNull();
    expect(resolveFrame(false, undefined)).toBeNull();
  });

  it("takes the defaults from `true`", () => {
    expect(resolveFrame(true, undefined)).toEqual(DEFAULT_FRAME_STYLE);
  });

  it("treats an object as on, merged over the defaults", () => {
    const style = resolveFrame({ padding: { bottom: 140 } }, undefined);
    expect(style?.padding).toEqual({ x: 80, top: 100, bottom: 140 });
    expect(style?.background).toBe(DEFAULT_FRAME_STYLE.background);
  });

  it("lets a scenario opt out of a config that framed everything", () => {
    expect(resolveFrame(true, false)).toBeNull();
  });

  it("merges a scenario's style over the config's without restating it", () => {
    const style = resolveFrame({ background: "#000" }, { caption: { color: "#fff" } });
    expect(style?.background).toBe("#000");
    expect(style?.caption.color).toBe("#fff");
    expect(style?.caption.fontWeight).toBe(DEFAULT_FRAME_STYLE.caption.fontWeight);
  });

  it("gives the flag the last word either way", () => {
    expect(resolveFrame(false, false, true)).toEqual(DEFAULT_FRAME_STYLE);
    expect(resolveFrame(true, { radius: 4 }, false)).toBeNull();
  });
});

describe("the machine-wide default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads SCREENCAST_FRAME", () => {
    expect(frameFromEnv({})).toBeUndefined();
    expect(frameFromEnv({ [FRAME_ENV]: "1" })).toBe(true);
    expect(frameFromEnv({ [FRAME_ENV]: "on" })).toBe(true);
    expect(frameFromEnv({ [FRAME_ENV]: "0" })).toBe(false);
  });

  it("refuses a value it cannot read, rather than recording the old way", () => {
    expect(() => frameFromEnv({ [FRAME_ENV]: "ture" })).toThrow(/SCREENCAST_FRAME/);
  });

  it("applies when the config says nothing, and loses to a config that does", () => {
    vi.stubEnv(FRAME_ENV, "1");
    expect(resolveConfig({}, null).frame).toBe(true);
    expect(resolveConfig({ frame: false }, null).frame).toBe(false);
  });

  it("leaves the config unframed when it is unset", () => {
    vi.stubEnv(FRAME_ENV, "");
    expect(resolveConfig({}, null).frame).toBeUndefined();
  });
});

describe("checking a frame setting", () => {
  it("accepts booleans and well-formed objects", () => {
    for (const ok of [undefined, true, false, { padding: { x: 40 } }, { radius: "auto" }]) {
      expect(() => assertFrameSetting(ok, "config")).not.toThrow();
    }
  });

  it("names the field that is wrong", () => {
    expect(() => assertFrameSetting({ padding: { bottom: -1 } }, "config")).toThrow(
      /frame\.padding\.bottom/,
    );
    expect(() => assertFrameSetting({ padding: { left: 10 } }, "config")).toThrow(
      /frame\.padding\.left/,
    );
    expect(() => assertFrameSetting("yes", "config")).toThrow(/`frame`/);
    expect(() => assertFrameSetting({ shadow: 3 }, "config")).toThrow(/frame\.shadow/);
  });

  it("is applied to a config file", () => {
    expect(() => resolveConfig({ frame: { radius: -2 } as never }, null)).toThrow(/frame\.radius/);
  });
});

describe("the layout", () => {
  const style = DEFAULT_FRAME_STYLE;

  it("fits a desktop take into the deliverable width, padding included", () => {
    // The hand-made frame this replaces: 1440x900 in a 1280 budget.
    const layout = frameLayout({
      capture: { width: 1440, height: 900 },
      budgetWidth: 1280,
      style,
      isMobile: false,
    });
    expect(layout.canvas).toEqual({ width: 1280, height: 900 });
    expect(layout.app).toEqual({ x: 80, y: 100, width: 1120, height: 700 });
    expect(layout.radius).toBe(14);
    expect(layout.fontSize).toBe(26);
  });

  it("never scales a phone up, and rounds it like a phone", () => {
    const layout = frameLayout({
      capture: { width: 390, height: 664 },
      budgetWidth: 1280,
      style,
      isMobile: true,
    });
    expect(layout.app).toEqual({ x: 80, y: 100, width: 390, height: 664 });
    expect(layout.canvas).toEqual({ width: 550, height: 864 });
    expect(layout.radius).toBe(22);
    expect(layout.fontSize).toBe(19);
  });

  it("grows the caption band for a caption that needs it, and only then", () => {
    const base = { capture: { width: 1440, height: 900 }, budgetWidth: 1280, style };
    expect(frameLayout({ ...base, isMobile: false, captionBand: 60 }).band).toBe(100);
    const tall = frameLayout({ ...base, isMobile: false, captionBand: 131.5 });
    expect(tall.band).toBe(132);
    expect(tall.app.y).toBe(132);
    expect(tall.canvas.height).toBe(132 + 700 + 100);
  });

  it("keeps every edge even, which h264 needs", () => {
    const layout = frameLayout({
      capture: { width: 1001, height: 777 },
      budgetWidth: 1280,
      style: { ...style, padding: { x: 33, top: 51, bottom: 77 } },
      isMobile: false,
    });
    for (const n of [
      layout.canvas.width,
      layout.canvas.height,
      layout.app.width,
      layout.app.height,
    ]) {
      expect(n % 2).toBe(0);
    }
  });

  it("refuses padding that leaves the app unreadable", () => {
    expect(() =>
      frameLayout({
        capture: { width: 1440, height: 900 },
        budgetWidth: 640,
        style: { ...style, padding: { x: 200, top: 100, bottom: 100 } },
        isMobile: false,
      }),
    ).toThrow(/leaves the app 240px of a 640px-wide clip/);
  });
});

describe("captions on the clip's timeline", () => {
  it("places them by the trim, on the clock they were logged on", () => {
    const cues = captionCues(
      [
        { atMs: 2500, text: "one" },
        { atMs: 4000, text: "two" },
        { atMs: 6000, text: null },
      ],
      2,
      10,
    );
    expect(cues).toEqual([
      { text: "one", start: 0.5, end: 2, fadeIn: true, fadeOut: false },
      { text: "two", start: 2, end: 4, fadeIn: false, fadeOut: true },
    ]);
  });

  it("fades in again after a clear, and swaps at once between lines", () => {
    const cues = captionCues(
      [
        { atMs: 0, text: "a" },
        { atMs: 1000, text: null },
        { atMs: 2000, text: "b" },
        { atMs: 3000, text: "c" },
      ],
      0,
      5,
    );
    expect(cues.map((c) => [c.text, c.fadeIn, c.fadeOut])).toEqual([
      ["a", true, true],
      ["b", true, false],
      ["c", false, false],
    ]);
    expect(cues.at(-1)?.end).toBe(5);
  });

  it("treats the same line put up twice as one caption", () => {
    const cues = captionCues(
      [
        { atMs: 0, text: "same" },
        { atMs: 500, text: "same" },
        { atMs: 900, text: null },
      ],
      0,
      2,
    );
    expect(cues).toEqual([{ text: "same", start: 0, end: 0.9, fadeIn: true, fadeOut: true }]);
  });

  it("clamps a caption put up before the clip opened to its first frame", () => {
    const cues = captionCues([{ atMs: 100, text: "early" }], 1, 3);
    expect(cues[0]).toMatchObject({ start: 0, end: 3 });
  });
});

describe("the compose command", () => {
  const layout = frameLayout({
    capture: { width: 640, height: 400 },
    budgetWidth: 1280,
    style: DEFAULT_FRAME_STYLE,
    isMobile: false,
  });

  it("overlays each caption only for its own stretch, fading where the page would", () => {
    const args = composeArgs({
      input: "raw.webm",
      output: "out.mkv",
      trimStart: 1.5,
      durationSeconds: 6,
      fps: 30,
      layout,
      foreground: "fg.png",
      fadeSeconds: 0.2,
      cues: [
        { text: "a", start: 0, end: 2, fadeIn: true, fadeOut: false, file: "a.png" },
        { text: "b", start: 2, end: 4, fadeIn: false, fadeOut: true, file: "b.png" },
      ],
    });
    const graph = args[args.indexOf("-filter_complex") + 1] as string;

    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual(["-ss", "1.50"]);
    expect(graph).toContain(`pad=${layout.canvas.width}:${layout.canvas.height}:80:100`);
    // A swapped line is replaced at once; a cleared one stays up while it fades.
    expect(graph).toContain("[2:v]format=rgba,fade=t=in:st=0.000:d=0.200:alpha=1[c0]");
    expect(graph).toContain("enable='between(t,0.000,2.000)'");
    expect(graph).toContain("[3:v]format=rgba,fade=t=out:st=4.000:d=0.200:alpha=1[c1]");
    expect(graph).toContain("enable='between(t,2.000,4.200)'");
    expect(args).toContain("b.png");
  });
});

/**
 * Every caption change is logged, drawn or not: the band is composed from the
 * log, so a framed take must not lose it just because the page shows nothing.
 */
describe("the caption log", () => {
  it("keeps the log while leaving the page-side bar empty", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent("<body><p>app</p></body>");
      const director = new Director(
        page,
        { baseUrl: "http://127.0.0.1", pace: 0.1, steps: ["first", "second"], drawCaptions: false },
        Date.now(),
      );
      // The overlay API is not installed here, so a draw would be a no-op
      // anyway - this asserts the log, which is what the frame reads.
      await director.step(0);
      await director.step(1);
      await director.caption(null);
      expect(director.captions.map((c) => c.text)).toEqual(["first", "second", null]);
      const times = director.captions.map((c) => c.atMs);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    } finally {
      await browser.close();
    }
  });
});

describe("composing a real capture", () => {
  let toolchain: Toolchain;
  let dir: string;
  let input: string;

  beforeAll(async () => {
    toolchain = await detectToolchain();
    dir = await mkdtemp(join(tmpdir(), "screencast-axi-frame-"));
    input = join(dir, "raw.webm");
    if (toolchain.ffmpeg) {
      // A flat mid-grey "app", so anything dark in the band is the caption.
      await runOrThrow(toolchain.ffmpeg.path, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x9aa0a6:size=640x400:rate=25:duration=4",
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

  it("puts the take on its canvas, with the caption in the band only while it is up", async () => {
    if (!toolchain.ffmpeg) {
      console.warn("skipped: ffmpeg not available on this machine");
      return;
    }
    const ffmpeg = toolchain.ffmpeg.path;
    const composed = await composeFrame({
      input,
      workDir: dir,
      id: "sample",
      ffmpeg,
      style: DEFAULT_FRAME_STYLE,
      capture: { width: 640, height: 400 },
      budgetWidth: 1280,
      isMobile: false,
      fps: 25,
      trimStart: 0.5,
      clipStartOnClock: 0.5,
      durationSeconds: 3,
      captions: [
        { atMs: 1000, text: "Shown in the band above the app" },
        { atMs: 2000, text: null },
      ],
      fontFamily: "sans-serif",
      fadeMs: 0,
    });

    expect(composed.layout.canvas).toEqual({ width: 800, height: 600 });
    expect(composed.cues).toEqual([
      expect.objectContaining({ start: 0.5, end: 1.5, fadeOut: true }),
    ]);

    // Darkest pixel in the band, before, during and after the caption.
    const bandMin = async (at: number): Promise<number> => {
      const result = await run(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "info",
        "-ss",
        String(at),
        "-i",
        composed.path,
        "-frames:v",
        "1",
        "-vf",
        `crop=800:${composed.layout.band}:0:0,signalstats,metadata=print:key=lavfi.signalstats.YMIN`,
        "-f",
        "null",
        "-",
      ]);
      return Number(/YMIN=([0-9.]+)/.exec(result.stderr)?.[1]);
    };
    expect(await bandMin(0.2)).toBeGreaterThan(180);
    expect(await bandMin(1.0)).toBeLessThan(80);
    expect(await bandMin(2.5)).toBeGreaterThan(180);
  }, 180_000);
});
