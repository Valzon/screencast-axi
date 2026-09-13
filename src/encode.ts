import { mkdir, rename, rm, stat } from "node:fs/promises";
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
  /**
   * VP9 quality for the webm.
   *
   * The webm only earns its place by being the smaller of the two, since it is
   * offered first and h264 plays everywhere. At CRF 34 it was not: measured
   * across the demo clips and a 1280x800 Wikipedia take, the webm came out
   * *larger* than the mp4 on four of five, so every viewer whose browser
   * preferred it downloaded more bytes for the same picture, and the encode
   * cost five times the h264 pass to produce them.
   *
   * VP9 and h264 do not share a CRF scale - 40 here is not "worse" than 23
   * there. At 40 the same take is 796 KB against the mp4's 1056 KB, with no
   * visible difference on text at 1:1.
   */
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
  webm: { crf: 40 },
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
  /**
   * Where to cut the poster from, in seconds into the raw capture.
   *
   * Not the clip's first frame, which is what it used to be. The overlay fades
   * its caption and pointer in over a couple of hundred milliseconds, so frame
   * one catches them part-way and the poster - the single still every visitor
   * sees before the video decodes - showed a half-transparent caption smeared
   * over the page. A moment later everything has settled.
   */
  readonly posterAt?: number;
  /**
   * How much of the capture, after the trim, is the clip.
   *
   * The raw video keeps rolling through teardown and the context close, so
   * without this the file ran past the take the manifest describes - by up to
   * 0.85s on a slow-paced clip, which is how a recorder ends up claiming one
   * length and delivering another.
   */
  readonly durationSeconds?: number;
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

  /**
   * Deliverables are written under a staging name and moved into place only
   * once every format has succeeded.
   *
   * Encoding straight to the final names meant a run that failed part-way -
   * a bad viewport, a missing encoder, a killed process - had already
   * replaced the previous clip with a truncated one. A 261-byte mp4 with no
   * streams, sitting where twenty seconds of working video used to be, while
   * the manifest still described the old take.
   */
  const staged: { from: string; to: string }[] = [];
  const stage = (name: string): string => {
    const to = join(opts.outDir, name);
    // The extension has to survive: ffmpeg and cwebp both pick their output
    // format from it, so `.part` on the end makes the encode fail instead of
    // protecting it. Hidden, and marked, but still an .mp4.
    const cut = name.lastIndexOf(".");
    const from = join(opts.outDir, `.${name.slice(0, cut)}.part${name.slice(cut)}`);
    staged.push({ from, to });
    return from;
  };
  const discardStaged = async (): Promise<void> => {
    await Promise.all(staged.map(({ from }) => rm(from, { force: true })));
  };

  try {
    return await run();
  } catch (error) {
    await discardStaged();
    throw error;
  }

  async function run(): Promise<EncodeResult> {
    // Input seek: `-ss` before `-i` is the fast, frame-accurate-enough form for
    // trimming dead air off the head.
    const trim = opts.trimStart > 0.05 ? ["-ss", opts.trimStart.toFixed(2)] : [];
    // An output option, not an input one: measured on a real capture, `-t`
    // before `-i` came out 33ms long while after it landed exactly. A poster is
    // a single frame and takes none of this.
    const limit =
      opts.durationSeconds !== undefined && opts.durationSeconds > 0.05
        ? ["-t", opts.durationSeconds.toFixed(3)]
        : [];
    // `-2` keeps the height even, which h264's yuv420p requires.
    const scale = `scale=${opts.width}:-2:flags=lanczos`;

    const mp4 = stage(`${opts.id}.mp4`);
    const webm = stage(`${opts.id}.webm`);

    // In sequence, deliberately. Each pass already saturates the machine - VP9
    // with `-row-mt` most of all - so running the three concurrently only makes
    // them contend: measured on a 10s 1280x800 clip across ten cores, 7.4s in
    // sequence against 7.6s in parallel.
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
      ...limit,
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
      ...limit,
      webm,
    ]);

    // The poster gets its own seek: see `posterAt`.
    const posterSeek =
      opts.posterAt !== undefined && opts.posterAt > 0.05
        ? ["-ss", opts.posterAt.toFixed(2)]
        : trim;
    const poster = await encodePoster(opts, toolchain, ffmpeg, posterSeek, scale, stage);

    // Both looping formats come from the same palette pass, so asking for the
    // pair costs one extra conversion rather than a second encode.
    let gif: string | undefined;
    let animatedWebp: string | undefined;
    if (opts.gif || opts.animatedWebp) {
      const wantsGif = opts.gif;
      gif = stage(`${opts.id}.gif`);
      const palette = join(opts.outDir, `.${opts.id}.palette.png`);
      // Never wider than the deliverable it is cut from. The default loop width
      // is sized for a desktop clip, and applying it to a phone capture scaled a
      // 360px recording up to 800px - a blurrier picture in a file several times
      // the size, which is the opposite of what these formats are for.
      const loopWidth = Math.min(opts.gifWidth, opts.width);
      const gifScale = `fps=${opts.gifFps},scale=${loopWidth}:-1:flags=lanczos`;
      await runOrThrow(ffmpeg, [
        ...QUIET,
        ...trim,
        "-i",
        opts.input,
        "-vf",
        `${gifScale},palettegen=max_colors=192:stats_mode=diff`,
        ...limit,
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
        ...limit,
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
        animatedWebp = stage(`${opts.id}.anim.webp`);
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

    // Every format encoded. Only now does anything replace what was there.
    const produced = new Set([mp4, webm, poster, gif, animatedWebp].filter(Boolean));
    const published = new Map<string, string>();
    for (const { from, to } of staged) {
      if (!produced.has(from)) {
        // Staged but not wanted in the end - the GIF behind `--webp` alone.
        await rm(from, { force: true });
        continue;
      }
      await rename(from, to);
      published.set(from, to);
    }

    const final = (path: string | undefined): string | undefined =>
      path === undefined ? undefined : (published.get(path) ?? path);

    const sizes: Record<string, number> = {};
    for (const file of [mp4, webm, poster, gif, animatedWebp]
      .map(final)
      .filter((f): f is string => Boolean(f))) {
      sizes[basename(file)] = (await stat(file)).size;
    }

    return {
      mp4: final(mp4) as string,
      webm: final(webm) as string,
      poster: final(poster) as string,
      ...(gif ? { gif: final(gif) as string } : {}),
      ...(animatedWebp ? { animatedWebp: final(animatedWebp) as string } : {}),
      sizes,
      posterEncoder: toolchain.posterEncoder,
    };
  }
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
  stage: (name: string) => string,
): Promise<string> {
  if (toolchain.posterEncoder === "png") {
    const png = stage(`${opts.id}.png`);
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

  const webp = stage(`${opts.id}.webp`);

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
