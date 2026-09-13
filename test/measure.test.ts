import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMeasurement, writeMeasurement, type MeasurementKey } from "../src/measure.js";
import { VERSION } from "../src/version.js";

let raw: string;

const KEY: MeasurementKey = {
  scenarioId: "tour",
  sourceText: "export default { id: 'tour' }",
  steps: ["one", "two"],
  baseUrl: "https://example.com",
  width: 1280,
  height: 800,
  timing: { settleMs: 2500, rehearseMs: 8000, actionMs: 15000, pace: 1 },
};

const RESULT = { durationMs: 8400, scaledPauseMs: 5200 };

beforeEach(() => {
  raw = mkdtempSync(join(tmpdir(), "measure-"));
});
afterEach(() => rmSync(raw, { recursive: true, force: true }));

describe("reusing a measured length", () => {
  it("reads back what it wrote", async () => {
    writeMeasurement(raw, KEY, RESULT);
    expect(readMeasurement(raw, KEY)).toMatchObject(RESULT);
  });

  it("has nothing to say before anything is measured", () => {
    expect(readMeasurement(raw, KEY)).toBeNull();
  });

  /**
   * Every one of these would change how long the take runs, and a cache that
   * is wrong about a clip's length produces a clip of the wrong length with
   * nothing on screen to say why. Re-measuring costs one pass; being wrong
   * costs the deliverable.
   */
  it.each([
    ["an edited scenario", { sourceText: "export default { id: 'tour', changed: true }" }],
    ["changed narration", { steps: ["one", "two", "three"] }],
    ["a different origin", { baseUrl: "https://staging.example.com" }],
    ["a different width", { width: 390 }],
    ["a different height", { height: 844 }],
    ["a device preset", { device: "iPhone 13" }],
    [
      // The knob `guide duration` tells people to turn, and it feeds the half
      // of the model the measuring pass treats as fixed.
      "a different settle ceiling",
      { timing: { settleMs: 50, rehearseMs: 8000, actionMs: 15000, pace: 1 } },
    ],
    [
      "a different action timeout",
      { timing: { settleMs: 2500, rehearseMs: 8000, actionMs: 45000, pace: 1 } },
    ],
    ["another scenario's id", { scenarioId: "other" }],
  ])("is not reused after %s", (_label, over) => {
    writeMeasurement(raw, KEY, RESULT);
    expect(readMeasurement(raw, { ...KEY, ...over })).toBeNull();
  });

  it("is not reused across recorder versions", () => {
    // Timing behaviour is the recorder's, so a new one has to measure again.
    writeMeasurement(raw, KEY, RESULT);
    const file = join(raw, "measure", "tour.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(stored["recorderVersion"]).toBe(VERSION);
    writeFileSync(file, JSON.stringify({ ...stored, recorderVersion: "0.0.0-old" }));
    expect(readMeasurement(raw, KEY)).toBeNull();
  });

  it("treats a corrupt entry as absent rather than failing", () => {
    mkdirSync(join(raw, "measure"), { recursive: true });
    writeFileSync(join(raw, "measure", "tour.json"), "{ not json");
    expect(readMeasurement(raw, KEY)).toBeNull();
  });

  it("does not throw when the cache cannot be written", () => {
    // A read-only or missing directory is a slower next run, not a failure.
    expect(() => writeMeasurement(join(raw, "nope", "\0bad"), KEY, RESULT)).not.toThrow();
  });
});
