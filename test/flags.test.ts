import { describe, expect, it } from "vitest";
import { ScreencastError } from "../src/errors.js";
import { nearestFlag, parseFlags, renderFlagHelp, type FlagSpecs } from "../src/flags.js";

const SPECS: FlagSpecs = {
  out: { kind: "string", description: "Output directory", placeholder: "dir" },
  duration: { kind: "string", description: "Target clip length", placeholder: "30s" },
  pace: { kind: "number", description: "Speed multiplier" },
  headed: { kind: "boolean", description: "Show the browser" },
  gif: { kind: "boolean", description: "Also emit a GIF" },
  tag: { kind: "string", description: "Filter by tag", repeat: true },
};

function error(args: string[]): ScreencastError {
  try {
    parseFlags(args, SPECS);
  } catch (e) {
    return e as ScreencastError;
  }
  throw new Error("expected parseFlags to throw");
}

describe("parsing", () => {
  it("reads values in both forms", () => {
    expect(parseFlags(["--out", "demos", "--duration=30s"], SPECS).flags).toEqual({
      out: "demos",
      duration: "30s",
    });
  });

  it("coerces numbers", () => {
    expect(parseFlags(["--pace", "0.35"], SPECS).flags).toEqual({ pace: 0.35 });
  });

  it("treats a bare switch as true and --no-x as false", () => {
    expect(parseFlags(["--headed"], SPECS).flags).toEqual({ headed: true });
    expect(parseFlags(["--no-headed"], SPECS).flags).toEqual({ headed: false });
  });

  it("collects repeated flags and keeps the last of non-repeating ones", () => {
    expect(parseFlags(["--tag", "a", "--tag", "b"], SPECS).flags).toEqual({ tag: ["a", "b"] });
    expect(parseFlags(["--out", "a", "--out", "b"], SPECS).flags).toEqual({ out: "b" });
  });

  it("keeps positionals in order and stops parsing at --", () => {
    const parsed = parseFlags(["one", "--headed", "two", "--", "--out"], SPECS);
    expect(parsed.positionals).toEqual(["one", "two", "--out"]);
    expect(parsed.flags).toEqual({ headed: true });
  });

  it("accepts a value that looks like a flag", () => {
    expect(parseFlags(["--out", "--weird"], SPECS).flags).toEqual({ out: "--weird" });
  });
});

/**
 * An unknown flag must be loud. A silently dropped flag makes the command look
 * like it succeeded while doing something the caller did not ask for, and an
 * agent that cannot see the mistake repeats it.
 */
describe("rejecting bad input", () => {
  it("rejects an unknown flag as a usage error", () => {
    const e = error(["--quality", "high"]);
    expect(e).toBeInstanceOf(ScreencastError);
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.message).toBe("Unknown flag: --quality");
  });

  it("suggests the nearest real flag, and lists them all", () => {
    const e = error(["--durtaion", "30s"]);
    expect(e.suggestions[0]).toBe("Did you mean `--duration`?");
    expect(e.suggestions.join(" ")).toContain("--out");
  });

  it("does not invent a suggestion for something unrelated", () => {
    expect(error(["--zzzzzzzz"]).suggestions[0]).not.toContain("Did you mean");
  });

  it("rejects a missing value", () => {
    expect(error(["--out"]).message).toBe("--out expects a value");
  });

  it("rejects a non-numeric number", () => {
    expect(error(["--pace", "fast"]).message).toContain("expects a number");
  });

  it("rejects a value handed to a switch", () => {
    expect(error(["--headed=yes"]).message).toContain("takes no value");
  });

  it("reports an unknown --no-x by the flag the caller typed", () => {
    expect(error(["--no-colour"]).message).toBe("Unknown flag: --no-colour");
  });
});

describe("nearestFlag", () => {
  it("matches a one-character typo", () => {
    expect(nearestFlag("hedaed", ["headed", "gif"])).toBe("headed");
  });

  it("returns null when nothing is close", () => {
    expect(nearestFlag("xyz", ["headed", "gif"])).toBeNull();
  });
});

describe("help rendering", () => {
  it("shows placeholders and aligns descriptions", () => {
    const lines = renderFlagHelp({
      out: { kind: "string", description: "Output directory", placeholder: "dir" },
      gif: { kind: "boolean", description: "Also emit a GIF" },
    });
    expect(lines[0]).toContain("--out <dir>");
    expect(lines[1]).toContain("--gif");
    expect(lines[0]?.indexOf("Output")).toBe(lines[1]?.indexOf("Also"));
  });
});
