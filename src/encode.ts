import { mkdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  detectToolchain,
  installHint,
  missingFfmpegError,
  runOrThrow,
  type PosterEncoder,
  type Toolchain,
} from "./toolchain.js";

export interface EncodeSettings {
  /** Output width in px; height follows the source aspect ratio. */
  readonly width: number;
  /** Frame rate of the mp4 and webm deliverables. */
  readonly fps: number;
  readonly mp4: { readonly crf: number; readonly preset: string; readonly profile: string };
  readonly webm: { readonly crf: number };
  readonly poster: { readonly quality: number };
  /**
   * Looping images, for the places a `<video>` does not render: a README, an
   * npm page, an email. Both are opt-in and both are far heavier than the mp4
   * - measured on a real 16.7s screencast at 800px/15fps, the mp4 was 182 KB,
   * animated WebP 944 KB and GIF 2,034 KB.
   *
   * Prefer WebP: same content, roughly half the bytes, and full colour rather
   * than a 256-entry palette. GIF is the fallback for somewhere that will not
   * render WebP.
   */
  readonly gif: boolean;
  readonly animatedWebp: boolean;
  readonly gifWidth: number;
  readonly gifFps: number;
  /** Quality for the animated WebP, 0-100. */
  readonly animatedWebpQuality: number;
}

export const DEFAULT_ENCODE_SETTINGS: EncodeSettings = {
  width: 1280,
  fps: 30,
  mp4: { crf: 23, preset: "slow", profile: "high" },
  webm: { crf: 34 },
  poster: { quality: 82 },
  gif: false,
  animatedWebp: false,
  gifWidth: 800,
  gifFps: 15,
  animatedWebpQuality: 55,
};

export interface EncodeOptions extends EncodeSettings {
  /** Raw Playwright capture (VP8 webm). */
  readonly input: string;
  /** Directory the deliverables are written to. */
  readonly outDir: string;
  /** File stem, e.g. `task-create`. */
  readonly id: string;
  /** Seconds to cut off the head: setup, navigation, first paint. */
  readonly trimStart: number;
  /** Pre-detected toolchain, so a batch does not re-probe per clip. */
  readonly toolchain?: Toolchain;
}

export interface EncodeResult {
  readonly mp4: string;
  readonly webm: string;
  readonly poster: string;
  readonly gif?: string;
  readonly animatedWebp?: string;
  /** Byte size per deliverable, keyed by file name. */
  readonly sizes: Readonly<Record<string, number>>;
  /** Which poster path was taken, for the CLI to report. */
  readonly posterEncoder: PosterEncoder;
}

const QUIET = ["-y", "-hide_banner", "-loglevel", "error"] as const;

/**
 * Turns the raw Playwright capture into web deliverables.
 *
 * - mp4  (h264, yuv420p, faststart) - the one a page plays.
 * - webm (vp9) - smaller, served first via `<source>`.
 * - poster - the frame shown before the video decodes, so nothing pops in.
 * - gif  - optional, opt-in.
 */
export async function encode(opts: EncodeOptions): Promise<EncodeResult> {
  const toolchain = opts.toolchain ?? (await detectToolchain());
  if (!toolchain.ffmpeg) throw missingFfmpegError();
  const ffmpeg = toolchain.ffmpeg.path;

  await mkdir(opts.outDir, { recursive: true });

  // Input seek: `-ss` before `-i` is the fast, frame-accurate-enough form for
  // trimming dead air off the head.
  const trim = opts.trimStart > 0.05 ? ["-ss", opts.trimStart.toFixed(2)] : [];
  // `-2` keeps the height even, which h264's yuv420p requires.
  const scale = `scale=${opts.width}:-2:flags=lanczos`;

  const mp4 = join(opts.outDir, `${opts.id}.mp4`);
  const webm = join(opts.outDir, `${opts.id}.webm`);

  await runOrThrow(ffmpeg, [
    ...QUIET,
    ...trim,
    "-i",
    opts.input,
    "-vf",
    `fps=${opts.fps},${scale}`,
    "-an",
    "-c:v",
    "libx264",
    "-profile:v",
    opts.mp4.profile,
    "-preset",
    opts.mp4.preset,
    "-crf",
    String(opts.mp4.crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4,
  ]);

  await runOrThrow(ffmpeg, [
    ...QUIET,
    ...trim,
    "-i",
    opts.input,
    "-vf",
    `fps=${opts.fps},${scale}`,
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    String(opts.webm.crf),
    "-b:v",
    "0",
    "-row-mt",
    "1",
    "-deadline",
    "good",
    webm,
  ]);

  const poster = await encodePoster(opts, toolchain, ffmpeg, trim, scale);

  // Both looping formats come from the same palette pass, so asking for the
  // pair costs one extra conversion rather than a second encode.
  let gif: string | undefined;
  let animatedWebp: string | undefined;
  if (opts.gif || opts.animatedWebp) {
    const wantsGif = opts.gif;
    gif = join(opts.outDir, `${opts.id}.gif`);
    const palette = join(opts.outDir, `.${opts.id}.palette.png`);
    const gifScale = `fps=${opts.gifFps},scale=${opts.gifWidth}:-1:flags=lanczos`;
    await runOrThrow(ffmpeg, [
      ...QUIET,
      ...trim,
      "-i",
      opts.input,
      "-vf",
      `${gifScale},palettegen=max_colors=192:stats_mode=diff`,
      palette,
    ]);
    await runOrThrow(ffmpeg, [
      ...QUIET,
      ...trim,
      "-i",
      opts.input,
      "-i",
      palette,
      "-lavfi",
      `${gifScale}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
      "-loop",
      "0",
      gif,
    ]);
    await rm(palette, { force: true });

    if (opts.animatedWebp) {
      // gif2webp rather than ffmpeg: the same builds that lack libwebp for the
      // poster lack it here too, and gif2webp ships in the same package as the
      // cwebp the poster already falls back to.
      const converter = toolchain.gif2webp;
      if (!converter) {
        throw new Error(
          "gif2webp was not found, so an animated WebP cannot be produced. " +
            `Install it with \`${installHint("cwebp")}\` (same package as cwebp), ` +
            "or drop `animatedWebp` and use the GIF.",
        );
      }
      animatedWebp = join(opts.outDir, `${opts.id}.anim.webp`);
      await runOrThrow(converter.path, [
        "-quiet",
        "-lossy",
        "-q",
        String(opts.animatedWebpQuality),
        "-m",
        "6",
        gif,
        "-o",
        animatedWebp,
      ]);
    }

    if (!wantsGif) {
      await rm(gif, { force: true });
      gif = undefined;
    }
  }

  const sizes: Record<string, number> = {};
  for (const file of [mp4, webm, poster, gif, animatedWebp].filter((f): f is string =>
    Boolean(f),
  )) {
    sizes[basename(file)] = (await stat(file)).size;
  }

  return {
    mp4,
    webm,
    poster,
    ...(gif ? { gif } : {}),
    ...(animatedWebp ? { animatedWebp } : {}),
    sizes,
    posterEncoder: toolchain.posterEncoder,
  };
}

/**
 * The poster, by whichever route this machine can take.
 *
 * WebP matters here: a 1280x800 screenshot of an app is roughly 300 KB as PNG
 * and 40 KB as WebP, and a page loads every poster up front because it is the
 * frame a not-yet-playing clip shows. But WebP is an optimisation, not a
 * requirement - falling back to PNG keeps a recording working on a machine
 * with neither encoder.
 */
async function encodePoster(
  opts: EncodeOptions,
  toolchain: Toolchain,
  ffmpeg: string,
  trim: readonly string[],
  scale: string,
): Promise<string> {
  if (toolchain.posterEncoder === "png") {
    const png = join(opts.outDir, `${opts.id}.png`);
    await runOrThrow(ffmpeg, [
      ...QUIET,
      ...trim,
      "-i",
      opts.input,
      "-vf",
      scale,
      "-frames:v",
      "1",
      png,
    ]);
    return png;
  }

  const webp = join(opts.outDir, `${opts.id}.webp`);

  if (toolchain.posterEncoder === "ffmpeg") {
    await runOrThrow(ffmpeg, [
      ...QUIET,
      ...trim,
      "-i",
      opts.input,
      "-vf",
      scale,
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      String(opts.poster.quality),
      webp,
    ]);
    return webp;
  }

  // cwebp: extract a frame, convert, drop the intermediate.
  const frame = join(opts.outDir, `.${opts.id}.poster.png`);
  await runOrThrow(ffmpeg, [
    ...QUIET,
    ...trim,
    "-i",
    opts.input,
    "-vf",
    scale,
    "-frames:v",
    "1",
    frame,
  ]);
  await runOrThrow(toolchain.cwebp?.path ?? "cwebp", [
    "-quiet",
    "-q",
    String(opts.poster.quality),
    "-m",
    "6",
    frame,
    "-o",
    webp,
  ]);
  await rm(frame, { force: true });
  return webp;
}
