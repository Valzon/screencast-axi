import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolvePlaywright } from "./browser.js";
import { ScreencastError } from "./errors.js";
import type { DeepPartial } from "./overlay.js";
import { runOrThrow } from "./toolchain.js";
import type { Viewport } from "./types.js";

/**
 * The frame: the recorded app as a card on a padded canvas.
 *
 * Two problems with a bare capture, both seen on real clips. A caption drawn
 * inside the page covers the app it is describing - the very button the
 * narration points at is under it. And a video player draws its controls over
 * the bottom of the picture, which on a bare capture is the app's own footer,
 * tab bar or send button. The frame moves both out of the way: captions go in
 * a band above the card, and the band below it is empty canvas for the
 * player's controls to sit on.
 *
 * Captions in the band are not burnt in by the page. The Director logs when
 * each one went up and came down, on the same clock the head-trim is measured
 * on, and the band is composed from that log - so they land on the frame the
 * page would have shown them on, with no offset to align by hand.
 *
 * Everything typographic is rendered by the browser, not by ffmpeg: the canvas,
 * the card's shadow and each caption are screenshots of a small page. ffmpeg's
 * `drawtext` needs a build with libfreetype and a font file path, both of which
 * vary by machine; Chromium is already here and already has the fonts the
 * page-side caption used.
 */

export interface FrameStyle {
  /** The canvas. Any CSS background - a colour, a gradient. */
  readonly background: string;
  /**
   * Canvas around the card, in output pixels.
   *
   * `top` is the caption band: it grows if a caption needs more room, never
   * shrinks. `bottom` is the band a player's controls overlay - 100px clears
   * the controls of every mainstream player at desktop size.
   */
  readonly padding: { readonly x: number; readonly top: number; readonly bottom: number };
  /** Corner radius of the card. `auto` is 22 on a phone preset, 14 otherwise. */
  readonly radius: number | "auto";
  /** 1px ring around the card, or false for none. */
  readonly border: string | false;
  /** CSS box-shadow under the card, or false for none. */
  readonly shadow: string | false;
  readonly caption: {
    readonly color: string;
    /** `auto` scales with the canvas: 26 at 1280 wide, never below 19. */
    readonly fontSize: number | "auto";
    readonly fontWeight: number;
    /** Defaults to the overlay caption's font, so the two read as one design. */
    readonly fontFamily?: string;
    /** Fade in and out. Defaults to the overlay caption's `fadeMs`. */
    readonly fadeMs?: number;
  };
}

/** `true` for the defaults, an object to adjust them (and turn the frame on), `false` for off. */
export type FrameSetting = boolean | DeepPartial<FrameStyle>;

export const DEFAULT_FRAME_STYLE: FrameStyle = {
  background: "#e9ecef",
  padding: { x: 80, top: 100, bottom: 100 },
  radius: "auto",
  border: "#ced4da",
  shadow: "0 6px 20px rgba(33, 37, 41, 0.28)",
  caption: { color: "#212529", fontSize: "auto", fontWeight: 650 },
};

/** The environment variable that turns the frame on for every project on a machine. */
export const FRAME_ENV = "SCREENCAST_FRAME";

/**
 * The machine-wide default, from `SCREENCAST_FRAME`.
 *
 * Undefined when it is unset, so a config that says nothing keeps saying
 * nothing. Anything unrecognised is refused rather than read as off: a typo
 * in a shell profile should not silently record every clip the old way.
 */
export function frameFromEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = env[FRAME_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new ScreencastError(`${FRAME_ENV} should be 1 or 0, got \`${raw}\``, "INVALID_CONFIG", [
    `\`export ${FRAME_ENV}=1\` frames every recording on this machine`,
    "Unset it, or set it to 0, to record without the frame",
  ]);
}

/**
 * Whether a take is framed, and how.
 *
 * Most specific wins: the `--frame` / `--no-frame` flag, then the scenario,
 * then the config (which already folded in `SCREENCAST_FRAME`). An object at
 * either level means "on, styled like this", and the two objects merge, so a
 * scenario can change one colour without restating the rest.
 */
export function resolveFrame(
  config: FrameSetting | undefined,
  scenario: FrameSetting | undefined,
  override?: boolean,
): FrameStyle | null {
  const on =
    override ??
    (scenario !== undefined ? scenario !== false : config !== undefined && config !== false);
  if (!on) return null;
  const objectOf = (s: FrameSetting | undefined) => (typeof s === "object" ? s : undefined);
  return mergeFrame(mergeFrame(DEFAULT_FRAME_STYLE, objectOf(config)), objectOf(scenario));
}

function mergeFrame(base: FrameStyle, over: DeepPartial<FrameStyle> | undefined): FrameStyle {
  if (!over) return base;
  return {
    ...base,
    ...over,
    padding: { ...base.padding, ...over.padding },
    caption: { ...base.caption, ...over.caption },
  } as FrameStyle;
}

/**
 * Checks a `frame` value from a config or a scenario.
 *
 * Both are plain objects loaded at runtime, so the types promise nothing. A
 * negative padding or a string where a number belongs would otherwise surface
 * as an ffmpeg error after a full take had already been shot.
 */
export function assertFrameSetting(value: unknown, where: string): void {
  if (value === undefined || typeof value === "boolean") return;
  const bad = (field: string, wanted: string): never => {
    throw new ScreencastError(`${where}: \`${field}\` should be ${wanted}`, "INVALID_CONFIG", [
      "`frame: true` uses the defaults; `frame: false` turns it off",
      'An object adjusts them, e.g. `frame: { background: "#f1f3f5", padding: { bottom: 120 } }`',
    ]);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bad("frame", "true, false or an object");
  }
  const v = value as Record<string, unknown>;
  const padding = v["padding"];
  if (padding !== undefined) {
    if (typeof padding !== "object" || padding === null) bad("frame.padding", "an object");
    for (const [edge, n] of Object.entries(padding as Record<string, unknown>)) {
      if (!["x", "top", "bottom"].includes(edge)) bad(`frame.padding.${edge}`, "x, top or bottom");
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        bad(`frame.padding.${edge}`, "a number of pixels, 0 or more");
      }
    }
  }
  const radius = v["radius"];
  if (radius !== undefined && radius !== "auto" && !(typeof radius === "number" && radius >= 0)) {
    bad("frame.radius", '"auto" or a number of pixels');
  }
  for (const field of ["background"]) {
    if (v[field] !== undefined && typeof v[field] !== "string") bad(`frame.${field}`, "a string");
  }
  for (const field of ["border", "shadow"]) {
    if (v[field] !== undefined && v[field] !== false && typeof v[field] !== "string") {
      bad(`frame.${field}`, "a CSS string or false");
    }
  }
  const caption = v["caption"] as Record<string, unknown> | undefined;
  if (caption !== undefined) {
    if (typeof caption !== "object" || caption === null) bad("frame.caption", "an object");
    const size = caption["fontSize"];
    if (size !== undefined && size !== "auto" && !(typeof size === "number" && size > 0)) {
      bad("frame.caption.fontSize", '"auto" or a number of pixels');
    }
  }
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FrameLayout {
  /** The whole output picture. */
  readonly canvas: Viewport;
  /** Where the recorded app sits on it, scaled. */
  readonly app: Rect;
  readonly radius: number;
  readonly fontSize: number;
  /** Height of the caption band above the card. */
  readonly band: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The caption size `auto` resolves to for a canvas this wide. */
export function autoFontSize(canvasWidth: number): number {
  return Math.min(28, Math.max(19, Math.round(canvasWidth * 0.0205)));
}

/**
 * Where everything goes.
 *
 * The output stays within `deliverables.width`, as an unframed clip does: the
 * canvas takes the padding out of that budget and the app is scaled into what
 * is left. A capture narrower than the budget - a phone - is never scaled up;
 * the canvas is simply the capture plus its padding.
 *
 * Measured against the hand-made frames this replaces: a 1440x900 desktop take
 * in a 1280 budget lands at 1280x900 with the app at 80,100 1120x700, and an
 * iPhone 13 take at 550x864 with the app at 1:1.
 */
export function frameLayout(input: {
  readonly capture: Viewport;
  readonly budgetWidth: number;
  readonly style: FrameStyle;
  readonly isMobile: boolean;
  /** Height the tallest caption needs, gaps included. The band never shrinks below `padding.top`. */
  readonly captionBand?: number;
}): FrameLayout {
  const { capture, budgetWidth, style } = input;
  const x = Math.round(style.padding.x);
  const appWidth = even(Math.min(budgetWidth, capture.width + 2 * x) - 2 * x);
  if (appWidth < Math.min(capture.width, budgetWidth) / 2) {
    throw new ScreencastError(
      `The frame leaves the app ${appWidth}px of a ${budgetWidth}px-wide clip`,
      "INVALID_CONFIG",
      [
        `\`frame.padding.x\` is ${x}px on each side - lower it, or raise \`deliverables.width\``,
        "The card should be at least half the clip's width, or the app is unreadable",
      ],
    );
  }
  const appHeight = even((appWidth * capture.height) / capture.width);
  const band = Math.ceil(Math.max(style.padding.top, input.captionBand ?? 0));
  const width = appWidth + 2 * x;
  // h264's yuv420p needs even edges; the bottom band absorbs the odd pixel.
  const bottom = Math.round(style.padding.bottom);
  const height = even(band + appHeight + bottom + ((band + appHeight + bottom) % 2));

  const fontSize = style.caption.fontSize === "auto" ? autoFontSize(width) : style.caption.fontSize;
  const radius = style.radius === "auto" ? (input.isMobile ? 22 : 14) : style.radius;

  return {
    canvas: { width, height },
    app: { x, y: band, width: appWidth, height: appHeight },
    radius: Math.min(radius, appWidth / 2, appHeight / 2),
    fontSize,
    band,
  };
}

/** One caption as the Director put it up, on its clock (ms since the context opened). */
export interface CaptionEvent {
  readonly atMs: number;
  /** Null when the caption was cleared. */
  readonly text: string | null;
}

/** One caption on the clip's own timeline, in seconds. */
export interface CaptionCue {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Nothing was up before it, so it fades in; otherwise it replaces a line at once. */
  readonly fadeIn: boolean;
  /** It is cleared rather than replaced, so it fades out from `end`. */
  readonly fadeOut: boolean;
}

/**
 * The captions on the clip's timeline.
 *
 * The Director logs on the same clock the head-trim is measured from, so the
 * clip time of a caption is its log time minus the trim - exactly, rather
 * than by an offset someone reads off a log and types into a script. A
 * caption stays up until the next one replaces it or it is cleared, and it
 * fades the way the page-side bar does: in when it appears on an empty bar,
 * out when the bar is cleared, and swapped at once when one line replaces
 * another.
 */
export function captionCues(
  events: readonly CaptionEvent[],
  trimStartSeconds: number,
  durationSeconds: number,
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as CaptionEvent;
    if (!event.text) continue;
    // The same line put up twice in a row is one caption, not a flicker.
    const previous = i > 0 ? events[i - 1] : undefined;
    if (previous?.text === event.text) continue;

    let next = i + 1;
    while (next < events.length && events[next]?.text === event.text) next++;
    const endMs = next < events.length ? (events[next] as CaptionEvent).atMs : Infinity;

    const start = Math.max(0, event.atMs / 1000 - trimStartSeconds);
    const end = Math.min(durationSeconds, endMs / 1000 - trimStartSeconds);
    const before = cues.at(-1);
    if (end - start > 0.02) {
      cues.push({
        text: event.text,
        start,
        end,
        fadeIn: !before || before.fadeOut || before.end < start,
        fadeOut: next < events.length && !events[next]?.text,
      });
    }
  }
  return cues;
}

/** A caption already rendered to an image, ready to overlay. */
export interface RenderedCue extends CaptionCue {
  readonly file: string;
}

/**
 * The ffmpeg arguments that put the take on the canvas.
 *
 * The capture is scaled into the card's rectangle and padded out to the
 * canvas; the foreground - the canvas with a rounded hole where the card is,
 * plus its border and shadow - goes over it, which is what rounds the corners;
 * each caption is overlaid in the band for its own stretch of the timeline,
 * fading like the page-side bar does.
 *
 * Written losslessly: this is an intermediate, and the deliverables are all
 * cut from it by the ordinary encoder.
 */
export function composeArgs(opts: {
  readonly input: string;
  readonly output: string;
  readonly trimStart: number;
  readonly durationSeconds: number;
  readonly fps: number;
  readonly layout: FrameLayout;
  readonly foreground: string;
  readonly cues: readonly RenderedCue[];
  readonly fadeSeconds: number;
}): string[] {
  const { layout, fps } = opts;
  const length = opts.durationSeconds.toFixed(3);
  const still = (file: string) => [
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-t",
    length,
    "-i",
    file,
  ];

  const graph: string[] = [
    `[0:v]fps=${fps},scale=${layout.app.width}:${layout.app.height}:flags=lanczos,setsar=1,` +
      `pad=${layout.canvas.width}:${layout.canvas.height}:${layout.app.x}:${layout.app.y}[app]`,
    `[app][1:v]overlay=0:0:shortest=1[v0]`,
  ];
  let last = "v0";
  const fade = opts.fadeSeconds > 0.01 ? opts.fadeSeconds : 0;
  opts.cues.forEach((cue, i) => {
    // A cleared caption is still on screen while it fades, exactly as the
    // page-side bar is: the fade starts when it is cleared, not before.
    const until = cue.fadeOut ? Math.min(opts.durationSeconds, cue.end + fade) : cue.end;
    const fadeIn = cue.fadeIn ? Math.min(fade, (cue.end - cue.start) / 2) : 0;
    const fadeOut = cue.fadeOut ? until - cue.end : 0;
    const fades =
      (fadeIn > 0.01
        ? `,fade=t=in:st=${cue.start.toFixed(3)}:d=${fadeIn.toFixed(3)}:alpha=1`
        : "") +
      (fadeOut > 0.01
        ? `,fade=t=out:st=${cue.end.toFixed(3)}:d=${fadeOut.toFixed(3)}:alpha=1`
        : "");
    graph.push(`[${i + 2}:v]format=rgba${fades}[c${i}]`);
    graph.push(
      `[${last}][c${i}]overlay=0:0:enable='between(t,${cue.start.toFixed(3)},${until.toFixed(3)})'[v${i + 1}]`,
    );
    last = `v${i + 1}`;
  });
  graph.push(`[${last}]format=yuv420p[out]`);

  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(opts.trimStart > 0.05 ? ["-ss", opts.trimStart.toFixed(2)] : []),
    "-i",
    opts.input,
    ...still(opts.foreground),
    ...opts.cues.flatMap((cue) => still(cue.file)),
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-an",
    // Lossless and fast: every deliverable is re-encoded from this, so any
    // loss here would be paid twice.
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-qp",
    "0",
    "-t",
    length,
    opts.output,
  ];
}

/** Room above and below a caption inside its band. */
function captionGap(fontSize: number): number {
  return Math.round(fontSize * 0.75);
}

const LINE_HEIGHT = 1.3;

/**
 * The page the layers are screenshots of.
 *
 * The canvas is an element with a rounded hole cut where the card goes, so a
 * screenshot with no page background is transparent exactly where the video
 * shows through - antialiased corners included. The card itself has no fill:
 * its border and shadow are outer box-shadows, which a browser paints only
 * outside the rounded box.
 */
function layerPage(style: FrameStyle, layout: FrameLayout, fontFamily: string): string {
  const { canvas, app, radius } = layout;
  const r = radius;
  const hole =
    `M0 0H${canvas.width}V${canvas.height}H0Z ` +
    `M${app.x + r} ${app.y}H${app.x + app.width - r}` +
    `A${r} ${r} 0 0 1 ${app.x + app.width} ${app.y + r}V${app.y + app.height - r}` +
    `A${r} ${r} 0 0 1 ${app.x + app.width - r} ${app.y + app.height}H${app.x + r}` +
    `A${r} ${r} 0 0 1 ${app.x} ${app.y + app.height - r}V${app.y + r}` +
    `A${r} ${r} 0 0 1 ${app.x + r} ${app.y}Z`;
  const shadows = [
    ...(style.border ? [`0 0 0 1px ${style.border}`] : []),
    ...(style.shadow ? [style.shadow] : []),
  ];
  return `<!doctype html><html><head><style>
    html, body { margin: 0; background: transparent; }
    #canvas { position: fixed; inset: 0; background: ${style.background};
      clip-path: path(evenodd, "${hole}"); }
    #card { position: fixed; left: ${app.x}px; top: ${app.y}px;
      width: ${app.width}px; height: ${app.height}px; border-radius: ${r}px;
      box-shadow: ${shadows.length > 0 ? shadows.join(", ") : "none"}; }
    #band { position: fixed; left: 0; top: 0; width: ${canvas.width}px; height: ${layout.band}px;
      display: flex; align-items: center; justify-content: center; }
    #caption { max-width: ${app.width}px; box-sizing: border-box; text-align: center;
      color: ${style.caption.color}; font: ${style.caption.fontWeight} ${layout.fontSize}px/${LINE_HEIGHT} ${fontFamily};
      letter-spacing: .005em; overflow-wrap: anywhere; text-wrap: balance; }
  </style></head><body><div id="canvas"></div><div id="card"></div>
  <div id="band"><div id="caption"></div></div></body></html>`;
}

export interface ComposeFrameOptions {
  /** Raw Playwright capture. */
  readonly input: string;
  /** Scratch directory for the layers and the intermediate. */
  readonly workDir: string;
  readonly id: string;
  readonly ffmpeg: string;
  readonly style: FrameStyle;
  readonly capture: Viewport;
  readonly budgetWidth: number;
  readonly isMobile: boolean;
  readonly fps: number;
  /** Where the clip starts in the capture, in seconds. */
  readonly trimStart: number;
  /**
   * Where the clip starts on the recorder's clock, in seconds - the clock the
   * captions were logged on. Differs from `trimStart` by however late the
   * video started; see `measureClockOffset`.
   */
  readonly clipStartOnClock: number;
  readonly durationSeconds: number;
  readonly captions: readonly CaptionEvent[];
  /** Font of the page-side caption, used when the frame names none. */
  readonly fontFamily: string;
  readonly fadeMs: number;
}

export interface ComposedFrame {
  /** The framed take, trimmed and cut to length, ready for the encoder. */
  readonly path: string;
  readonly layout: FrameLayout;
  readonly cues: readonly CaptionCue[];
  /** Everything written along the way, for the caller to remove. */
  readonly scratch: readonly string[];
}

/**
 * Renders the layers and composes the framed take.
 *
 * A short-lived headless browser of its own, rather than a page in the take's
 * context: that context records every page it opens, and is already closed by
 * the time the capture exists.
 */
export async function composeFrame(opts: ComposeFrameOptions): Promise<ComposedFrame> {
  const dir = join(opts.workDir, `${opts.id}.frame`);
  await mkdir(dir, { recursive: true });
  const cues = captionCues(opts.captions, opts.clipStartOnClock, opts.durationSeconds);
  const fontFamily = opts.style.caption.fontFamily ?? opts.fontFamily;

  const provisional = frameLayout({
    capture: opts.capture,
    budgetWidth: opts.budgetWidth,
    style: opts.style,
    isMobile: opts.isMobile,
  });

  const { module } = await resolvePlaywright();
  const browser = await module.chromium.launch({ headless: true });
  let layout = provisional;
  const rendered: RenderedCue[] = [];
  const foreground = join(dir, "foreground.png");
  try {
    const page = await browser.newPage({
      viewport: provisional.canvas,
      deviceScaleFactor: 1,
    });
    await page.setContent(layerPage(opts.style, provisional, fontFamily));
    await page.evaluate(() => document.fonts.ready);

    // The band has to fit the longest caption, so measure them all first.
    const texts = [...new Set(cues.map((c) => c.text))];
    let tallest = 0;
    for (const text of texts) {
      const height = await page.evaluate((t) => {
        const el = document.getElementById("caption") as HTMLElement;
        el.textContent = t;
        return el.getBoundingClientRect().height;
      }, text);
      tallest = Math.max(tallest, height);
    }
    layout = frameLayout({
      capture: opts.capture,
      budgetWidth: opts.budgetWidth,
      style: opts.style,
      isMobile: opts.isMobile,
      ...(tallest > 0 ? { captionBand: tallest + 2 * captionGap(provisional.fontSize) } : {}),
    });

    await page.setViewportSize(layout.canvas);
    await page.setContent(layerPage(opts.style, layout, fontFamily));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: foreground, omitBackground: true });

    // Each caption alone, on a transparent band the width of the canvas.
    await page.evaluate(() => {
      for (const id of ["canvas", "card"]) document.getElementById(id)?.remove();
    });
    const files = new Map<string, string>();
    for (const [i, text] of texts.entries()) {
      const file = join(dir, `caption-${i}.png`);
      await page.evaluate((t) => {
        (document.getElementById("caption") as HTMLElement).textContent = t;
      }, text);
      await page.screenshot({
        path: file,
        omitBackground: true,
        clip: { x: 0, y: 0, width: layout.canvas.width, height: layout.band },
      });
      files.set(text, file);
    }
    for (const cue of cues) rendered.push({ ...cue, file: files.get(cue.text) as string });
  } finally {
    await browser.close();
  }

  const output = join(opts.workDir, `${opts.id}.framed.mkv`);
  await runOrThrow(
    opts.ffmpeg,
    composeArgs({
      input: opts.input,
      output,
      trimStart: opts.trimStart,
      durationSeconds: opts.durationSeconds,
      fps: opts.fps,
      layout,
      foreground,
      cues: rendered,
      fadeSeconds: opts.fadeMs / 1000,
    }),
  );

  return { path: output, layout, cues, scratch: [output, dir] };
}

/** Removes what {@link composeFrame} left behind. */
export async function discardFrameScratch(scratch: readonly string[]): Promise<void> {
  for (const path of scratch) await rm(path, { recursive: true, force: true });
}
