import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashSteps, hashText } from "./manifest.js";
import { VERSION } from "./version.js";

/**
 * Remembering how long a scenario takes at pace 1.
 *
 * `--duration` cannot guess a pace: a take is `fixed + pace x scalable`, and
 * only the scenario itself knows how much of it is the site's own waiting. So
 * the recorder measures, by running the whole scenario once without encoding
 * and then shooting it again for real. That is honest and it is also the
 * single most expensive thing `record` does - measured on a ten-second
 * Wikipedia clip, the discarded pass was 8.7s of a 28s run.
 *
 * The measurement is worth keeping, because what it describes barely changes:
 * the same scenario, at the same size, against the same origin, takes the same
 * time. Keyed on all three (plus the narration and the recorder version), a
 * rehearsal doubles as the measuring pass and a re-cut costs one browser run
 * instead of two.
 *
 * Anything that could move the number invalidates the entry rather than being
 * corrected for. A cache that is wrong about a clip's length is worse than no
 * cache: the clip comes out the wrong length and nothing says why.
 */

/** What was measured, and what it was measured against. */
export interface Measurement {
  readonly scenarioId: string;
  /** Hash of the scenario source, so any edit invalidates it. */
  readonly sourceHash: string;
  readonly stepsHash: string;
  readonly baseUrl: string;
  readonly width: number;
  readonly height: number;
  readonly device?: string;
  readonly recorderVersion: string;
  /** What a pace-1 take measured, in ms. */
  readonly durationMs: number;
  /** Of that, how much was pause the recorder controls. */
  readonly scaledPauseMs: number;
  readonly measuredAt: string;
}

/** Everything a measurement has to match to be reusable. */
export interface MeasurementKey {
  readonly scenarioId: string;
  readonly sourceText: string;
  readonly steps: readonly string[] | undefined;
  readonly baseUrl: string;
  readonly width: number;
  readonly height: number;
  readonly device?: string;
}

function fileFor(rawDir: string, id: string): string {
  return join(rawDir, "measure", `${id}.json`);
}

/**
 * Whether `entry` describes the take `key` is about to shoot.
 *
 * Every field is compared. A missing one fails the match: an entry written by
 * an older version that did not record a field cannot be shown to be valid,
 * and re-measuring costs one pass while being wrong costs a bad clip.
 */
export function matches(entry: Measurement, key: MeasurementKey): boolean {
  return (
    entry.scenarioId === key.scenarioId &&
    entry.sourceHash === hashText(key.sourceText) &&
    entry.stepsHash === hashSteps(key.steps) &&
    entry.baseUrl === key.baseUrl &&
    entry.width === key.width &&
    entry.height === key.height &&
    (entry.device ?? null) === (key.device ?? null) &&
    entry.recorderVersion === VERSION &&
    Number.isFinite(entry.durationMs) &&
    Number.isFinite(entry.scaledPauseMs)
  );
}

/**
 * The stored measurement for `key`, if one still describes it.
 *
 * Unreadable or unparseable is treated as absent: this is a cache, and a
 * corrupt one should cost a measuring pass, not the command.
 */
export function readMeasurement(rawDir: string, key: MeasurementKey): Measurement | null {
  const file = fileFor(rawDir, key.scenarioId);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Measurement;
    return matches(parsed, key) ? parsed : null;
  } catch {
    return null;
  }
}

/** Stores a pace-1 measurement. Failure to write is never fatal. */
export function writeMeasurement(
  rawDir: string,
  key: MeasurementKey,
  result: { durationMs: number; scaledPauseMs: number },
): void {
  const entry: Measurement = {
    scenarioId: key.scenarioId,
    sourceHash: hashText(key.sourceText),
    stepsHash: hashSteps(key.steps),
    baseUrl: key.baseUrl,
    width: key.width,
    height: key.height,
    ...(key.device ? { device: key.device } : {}),
    recorderVersion: VERSION,
    durationMs: result.durationMs,
    scaledPauseMs: result.scaledPauseMs,
    measuredAt: new Date().toISOString(),
  };
  try {
    const file = fileFor(rawDir, key.scenarioId);
    mkdirSync(join(rawDir, "measure"), { recursive: true });
    writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  } catch {
    // A cache that cannot be written is a slower next run, not a failure.
  }
}
