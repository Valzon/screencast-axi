import { describe, expect, it } from "vitest";
import { assertScriptComplete } from "../src/run.js";
import { selectorCandidates, selectorFromError } from "../src/forensics.js";
import { ScreencastError } from "../src/errors.js";

/**
 * The narration array is simultaneously the burnt-in caption, the manifest's
 * step list and the text a site renders beside the clip. A line that never
 * went on screen would leave the written workflow promising something the
 * video does not show, so a take that skips one is a failure, not a warning.
 */
describe("script completeness", () => {
  it("accepts every step shown once, in order", () => {
    expect(() => assertScriptComplete(["a", "b", "c"], [0, 1, 2])).not.toThrow();
  });

  it("accepts a scenario that declares no narration", () => {
    expect(() => assertScriptComplete(undefined, [])).not.toThrow();
    expect(() => assertScriptComplete([], [])).not.toThrow();
  });

  it("names the line that never appeared", () => {
    try {
      assertScriptComplete(["first", "second"], [0]);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ScreencastError);
      const e = error as ScreencastError;
      expect(e.code).toBe("SCRIPT_INCOMPLETE");
      expect(e.suggestions[0]).toContain('step 1 ("second")');
    }
  });

  it("rejects steps shown out of order", () => {
    expect(() => assertScriptComplete(["a", "b"], [1, 0])).toThrowError(/showed steps/);
  });

  it("rejects a step shown twice", () => {
    expect(() => assertScriptComplete(["a", "b"], [0, 0, 1])).toThrowError(/showed steps/);
  });
});

/**
 * A descendant selector that matches nothing says nothing about which part is
 * wrong. Its pieces do: a container that matched once with contents that
 * matched zero times is a data problem, not a typo - and that is a different
 * fix.
 */
describe("selector candidates", () => {
  it("breaks a descendant selector into prefixes and the tail", () => {
    expect(selectorCandidates(".grid .body .row")).toEqual([".grid .body", ".grid", ".row"]);
  });

  it("leaves a single selector alone", () => {
    expect(selectorCandidates("button.primary")).toEqual(["button.primary"]);
  });

  it("does not try to split a combinator it cannot reason about", () => {
    expect(selectorCandidates(".a > .b")).toEqual([".a > .b"]);
  });

  it("ignores surrounding whitespace", () => {
    expect(selectorCandidates("  .a .b  ")).toEqual([".a", ".b"]);
  });
});

describe("extracting the selector from a Playwright error", () => {
  it("reads a waitFor timeout", () => {
    const message =
      "locator.waitFor: Timeout 8000ms exceeded.\nCall log:\n  - waiting for locator('.ag-row').first() to be visible\n";
    expect(selectorFromError(message)).toBe(".ag-row");
  });

  it("returns null when there is no selector to find", () => {
    expect(selectorFromError("net::ERR_CONNECTION_REFUSED")).toBeNull();
  });
});
