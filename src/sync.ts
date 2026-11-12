import { run } from "./toolchain.js";

/**
 * Finding the sync mark in a raw capture.
 *
 * The recorder logs everything - the head-trim, each caption - in ms since the
 * page was created. The video's own clock starts when its first frame arrives,
 * a little later. `openContext` flashes the page grey at a logged moment; the
 * first grey frame says where that moment fell in the video, and the
 * difference between the two is the offset between the clocks.
 */

/** How far into a capture to look. The mark goes up before setup even starts. */
const SEARCH_SECONDS = 8;

/**
 * Luma of the mark, on ffmpeg's limited-range scale. `#808080` reads as about
 * 126; a blank page is 235 and an unpainted frame is near 16.
 */
const MARK_LUMA = { min: 110, max: 142 } as const;

/**
 * The time of the first grey frame, from ffmpeg's `signalstats` log.
 *
 * Kept separate from running ffmpeg so the parsing - the part that silently
 * returns nonsense if it is wrong - can be tested without a capture.
 */
export function parseSyncMark(log: string): number | null {
  let time: number | null = null;
  let first = true;
  for (const line of log.split("\n")) {
    const pts = /pts_time:([0-9.]+)/.exec(line);
    if (pts) {
      time = Number(pts[1]);
      continue;
    }
    const luma = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
    if (luma && time !== null) {
      const y = Number(luma[1]);
      const grey = y >= MARK_LUMA.min && y <= MARK_LUMA.max;
      // Grey on the very first frame means the video started after the mark
      // went up, so it marks nothing.
      if (grey) return first ? null : time;
      first = false;
    }
  }
  return null;
}

/**
 * Seconds to add to a time on the recorder's clock to get the same moment on
 * the video's, or null when the mark could not be found.
 *
 * Negative in practice: the video starts after the page does. Anything outside
 * a couple of seconds is not the mark but something grey on the page, and is
 * refused rather than trusted.
 */
export async function measureClockOffset(
  ffmpeg: string,
  capture: string,
  markAtMs: number,
): Promise<number | null> {
  const result = await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "info",
    "-t",
    String(SEARCH_SECONDS),
    "-i",
    capture,
    "-an",
    "-vf",
    // A thumbnail is enough to read a whole-page colour, and much cheaper.
    "scale=32:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f",
    "null",
    "-",
  ]);
  if (result.code !== 0) return null;
  const seen = parseSyncMark(result.stderr);
  if (seen === null) return null;
  const offset = seen - markAtMs / 1000;
  return Math.abs(offset) <= 2 ? offset : null;
}
