import { describe, expect, it } from "vitest";
import { MAX_PACE, MIN_PACE, parseDuration, solvePace } from "../src/duration.js";
import { captureSize } from "../src/browser.js";
import { ScreencastError } from "../src/errors.js";

describe("parsing a duration", () => {
  it("reads the forms someone would actually type", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("30")).toBe(30_000);
    expect(parseDuration("1m")).toBe(60_000);
    expect(parseDuration("1m30s")).toBe(90_000);
    expect(parseDuration("2m 5")).toBe(125_000);
    expect(parseDuration(" 45S ")).toBe(45_000);
    expect(parseDuration("7.5s")).toBe(7_500);
  });

  it("rejects anything it cannot read rather than guessing", () => {
    expect(() => parseDuration("about a minute")).toThrowError(ScreencastError);
    expect(() => parseDuration("")).toThrowError(/Cannot read a duration/);
  });
});

/**
 * A take is `fixed + pace x scalable`. The app's own waits - a navigation, a
 * network round trip - do not get slower because the recorder does, so solving
 * as though the whole clip scales undershoots by however long the site itself
 * took. On a real three-page tour that was the difference between landing 12%
 * under target and landing within half a percent.
 */
describe("solving for pace", () => {
  it("accounts for the part of a take that does not scale", () => {
    // 12s measured, of which 8.5s was pause: 3.5s is the site's own loading.
    const solution = solvePace(12_000, 20_000, 8_500);
    expect(solution.pace).toBeCloseTo((20_000 - 3_500) / 8_500, 2);
    expect(solution.clamped).toBe(false);
  });

  it("assumes everything scales when told nothing else", () => {
    expect(solvePace(10_000, 20_000).pace).toBe(2);
  });

  it("clamps rather than producing a clip nobody can follow", () => {
    const tooFast = solvePace(60_000, 5_000, 60_000);
    expect(tooFast.pace).toBe(MIN_PACE);
    expect(tooFast.clamped).toBe(true);
    expect(tooFast.warning).toContain("Drop a step");

    const tooSlow = solvePace(5_000, 60_000, 5_000);
    expect(tooSlow.pace).toBe(MAX_PACE);
    expect(tooSlow.warning).toContain("Add a beat");
  });

  it("says what the clamp will actually produce", () => {
    const solution = solvePace(60_000, 5_000, 60_000);
    expect(solution.warning).toContain("24s");
  });

  it("degrades to pace 1 on a measurement it cannot use", () => {
    expect(solvePace(0, 20_000).pace).toBe(1);
    expect(solvePace(10_000, 20_000, 0).pace).toBe(1);
  });
});

/**
 * Recording at the CSS viewport throws away what a device preset's
 * deviceScaleFactor renders, which on a phone is the whole difference between
 * readable UI text and a smear.
 */
/**
 * Regression: the capture used to be sized at the device's pixel ratio, on the
 * theory that it would make a phone clip sharper. It does not - Playwright
 * composites the page into the canvas without scaling up, so asking for more
 * than the viewport put the page in the top-left corner and left the rest of
 * every phone clip empty grey.
 */
describe("capture size", () => {
  it("never asks for more than the viewport", () => {
    const size = captureSize({
      viewport: { width: 390, height: 664 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    expect(size).toEqual({ width: 390, height: 664 });
  });

  it("leaves an ordinary desktop capture alone", () => {
    expect(
      captureSize({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
      }),
    ).toEqual({ width: 1280, height: 800 });
  });

  it("scales a very large viewport down, keeping the aspect", () => {
    const size = captureSize({
      viewport: { width: 3000, height: 2000 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1600);
    expect(size.width / size.height).toBeCloseTo(3000 / 2000, 2);
  });

  it("keeps both dimensions even, which h264 requires", () => {
    const size = captureSize({
      viewport: { width: 391, height: 665 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });
});
