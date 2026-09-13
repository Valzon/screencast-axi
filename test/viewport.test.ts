import { describe, expect, it } from "vitest";
import { resolveViewport } from "../src/browser.js";
import { ScreencastError } from "../src/errors.js";

const FALLBACK = { width: 1280, height: 800 };

/**
 * Either end of the range produces something that is not a recording. Below
 * the minimum there is no page to speak of - a 1x1 viewport recorded a 2x2
 * video and a 44-byte poster, and exited 0. Above the maximum Chromium fails
 * to allocate the surface and does so as an unsettled promise, so the process
 * exited 13 having printed no error at all.
 */
describe("viewports that cannot be recorded", () => {
  it("refuses one too small to hold a page", async () => {
    const error = await resolveViewport({ viewport: { width: 1, height: 1 } }, FALLBACK).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ScreencastError);
    expect((error as ScreencastError).code).toBe("VIEWPORT_OUT_OF_RANGE");
    expect((error as ScreencastError).message).toContain("too small");
  });

  it("refuses one Chromium cannot allocate, rather than dying without a message", async () => {
    const error = await resolveViewport(
      { viewport: { width: 99_999, height: 99_999 } },
      FALLBACK,
    ).catch((e: unknown) => e);
    expect((error as ScreencastError).code).toBe("VIEWPORT_OUT_OF_RANGE");
    expect((error as ScreencastError).message).toContain("too large");
  });

  it("accepts the smallest sizes people actually record at", async () => {
    const resolved = await resolveViewport({ viewport: { width: 320, height: 480 } }, FALLBACK);
    expect(resolved.viewport).toEqual({ width: 320, height: 480 });
  });

  it("accepts a large desktop", async () => {
    const resolved = await resolveViewport({ viewport: { width: 2560, height: 1440 } }, FALLBACK);
    expect(resolved.viewport).toEqual({ width: 2560, height: 1440 });
  });
});

/**
 * A preset and an explicit viewport is a legitimate combination - the preset
 * still supplies the user agent, scale factor and touch flags - but the page
 * is laid out at the size given. Printing the device name beside a
 * desktop-sized clip read as though the phone had been used whole.
 */
describe("a preset whose viewport was overridden", () => {
  it("says so", async () => {
    const resolved = await resolveViewport(
      { device: "iPhone 13", viewport: { width: 1440, height: 900 } },
      FALLBACK,
    );
    expect(resolved.viewport).toEqual({ width: 1440, height: 900 });
    expect(resolved.device).toBe("iPhone 13");
    expect(resolved.viewportOverridden).toBe(true);
  });

  it("says nothing when the preset was used as it comes", async () => {
    const resolved = await resolveViewport({ device: "iPhone 13" }, FALLBACK);
    expect(resolved.viewportOverridden).toBeUndefined();
  });

  it("says nothing when an explicit viewport matches the preset anyway", async () => {
    const preset = await resolveViewport({ device: "iPhone 13" }, FALLBACK);
    const again = await resolveViewport(
      { device: "iPhone 13", viewport: preset.viewport },
      FALLBACK,
    );
    expect(again.viewportOverridden).toBeUndefined();
  });
});
