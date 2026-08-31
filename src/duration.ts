import { ScreencastError } from "./errors.js";

/**
 * Turning "around 30 seconds" into a pace.
 *
 * Every deliberate pause in a take is multiplied by `pace`, so a clip's length
 * is roughly linear in it. Roughly, not exactly: Playwright's own waits - a
 * navigation, a network round trip, an animation settling - are not scaled,
 * because slowing the recorder down does not slow the app down. So the
 * resolved pace is measured rather than assumed, and what actually came out is
 * reported next to what was asked for.
 */

export const MIN_PACE = 0.4;
export const MAX_PACE = 2.5;

/** Parses `30s`, `1m30s`, `45`, `2m`. Returns milliseconds. */
export function parseDuration(input: string): number {
  const text = input.trim().toLowerCase();

  const clock = /^(\d+)m(?:in)?(?:\s*(\d+)s?)?$/.exec(text);
  if (clock) {
    return (Number(clock[1]) * 60 + Number(clock[2] ?? 0)) * 1000;
  }

  const seconds = /^(\d+(?:\.\d+)?)s(?:ec)?$/.exec(text);
  if (seconds) return Math.round(Number(seconds[1]) * 1000);

  const bare = /^(\d+(?:\.\d+)?)$/.exec(text);
  if (bare) return Math.round(Number(bare[1]) * 1000);

  throw new ScreencastError(`Cannot read a duration from \`${input}\``, "VALIDATION_ERROR", [
    "Use seconds (`30s`), minutes and seconds (`1m30s`), or a bare number of seconds (`30`)",
  ]);
}

export interface PaceSolution {
  readonly pace: number;
  readonly clamped: boolean;
  /** What a pace-1 take measured, in ms. */
  readonly naturalMs: number;
  readonly targetMs: number;
  /** Human note when the target could not be met. */
  readonly warning?: string;
}

/**
 * The pace that should land a take near `targetMs`, given a measured run.
 *
 * Clamped, because there is a point past which a clip stops being watchable:
 * below 0.4 the pointer teleports and typed text is a blur, above 2.5 it is
 * slower than anyone will sit through. Hitting a clamp is reported rather than
 * silently obeyed - the honest answer is "this scenario has too much in it for
 * 30 seconds", not a clip nobody can follow.
 */
export function solvePace(
  naturalMs: number,
  targetMs: number,
  scaledPauseMs = naturalMs,
): PaceSolution {
  if (naturalMs <= 0 || scaledPauseMs <= 0) {
    return { pace: 1, clamped: false, naturalMs, targetMs };
  }

  // A take is `fixed + pace x scalable`, measured at pace 1. Solving with the
  // real split lands close; assuming the whole clip scales undershoots by
  // whatever the app itself spent loading, which on a real site is seconds.
  const fixedMs = Math.max(0, naturalMs - scaledPauseMs);
  const ideal = (targetMs - fixedMs) / scaledPauseMs;
  const pace = Math.min(MAX_PACE, Math.max(MIN_PACE, ideal));
  const clamped = Math.abs(pace - ideal) > 1e-9;

  if (!clamped) {
    return { pace: Number(pace.toFixed(3)), clamped, naturalMs, targetMs };
  }

  const reachableMs = Math.round(fixedMs + scaledPauseMs * pace);
  return {
    pace: Number(pace.toFixed(3)),
    clamped,
    naturalMs,
    targetMs,
    warning:
      `target ${(targetMs / 1000).toFixed(0)}s needs pace ${ideal.toFixed(2)}, ` +
      `which is outside the watchable range - clamped to ${pace} for about ` +
      `${(reachableMs / 1000).toFixed(0)}s. ` +
      (ideal < MIN_PACE
        ? "Drop a step or a tour stop to make it shorter."
        : "Add a beat or another stop to fill the time."),
  };
}
