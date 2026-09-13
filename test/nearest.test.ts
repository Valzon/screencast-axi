import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closest, distance, loadableIn, nearest } from "../src/nearest.js";

let dir: string;

function scenarioDir(files: string[]): string {
  const scenarios = join(dir, "scenarios");
  mkdirSync(scenarios, { recursive: true });
  for (const f of files) writeFileSync(join(scenarios, f), "export default {};");
  return scenarios;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nearest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("how close two names are", () => {
  it("scores an exact match at nothing", () => {
    expect(distance("tour.ts", "tour.ts")).toBe(0);
  });

  it("scores a single typo at one", () => {
    expect(distance("ada.ts", "adb.ts")).toBe(1);
  });

  it("gives up rather than scoring two unrelated names precisely", () => {
    // The only question is "is this close", so the cap is the answer.
    expect(distance("a", "zzzzzzzzzzzzzzzz")).toBeGreaterThan(5);
  });
});

describe("what is loadable in a directory", () => {
  it("lists scenario files and ignores everything else", () => {
    const scenarios = scenarioDir(["tour.ts", "notes.md", "clip.mjs", "types.d.ts"]);
    expect(loadableIn(scenarios)).toEqual(["clip.mjs", "tour.ts"]);
  });

  it("answers with nothing for a path that is not a directory", () => {
    expect(loadableIn(join(dir, "absent"))).toEqual([]);
  });
});

/**
 * A missing scenario path is almost always nearly right, and the file meant is
 * usually sitting beside it. Naming that file is the difference between an
 * error that is correct and one that ends the detour.
 */
describe("what was probably meant", () => {
  it("names the file behind a typo", () => {
    scenarioDir(["ada.ts", "checkout.ts"]);
    const result = nearest(join(dir, "scenarios", "adb.ts"));
    expect(result.suggestion).toBe(join(dir, "scenarios", "ada.ts"));
  });

  it("names it behind a wrong extension too", () => {
    scenarioDir(["ada.ts"]);
    expect(nearest(join(dir, "scenarios", "ada.js")).suggestion).toBe(
      join(dir, "scenarios", "ada.ts"),
    );
  });

  it("guesses nothing when nothing is close, and lists what is there instead", () => {
    // A confident wrong guess is worse than the list.
    scenarioDir(["ada.ts", "checkout.ts"]);
    const result = nearest(join(dir, "scenarios", "zzzzzzzzzz.ts"));
    expect(result.suggestion).toBeUndefined();
    expect(result.siblings).toEqual(["ada.ts", "checkout.ts"]);
  });

  it("says when the path is a directory, which is a different mistake", () => {
    const scenarios = scenarioDir(["ada.ts"]);
    const result = nearest(scenarios);
    expect(result.isDirectory).toBe(true);
    expect(result.siblings).toEqual(["ada.ts"]);
  });

  it("reports an empty directory rather than inventing a neighbour", () => {
    const result = nearest(join(dir, "absent", "ada.ts"));
    expect(result.suggestion).toBeUndefined();
    expect(result.siblings).toEqual([]);
  });
});

/**
 * For ids and topic names, where the alternatives are already known. Listing
 * them is necessary; naming the likely one is what ends the guessing.
 */
describe("the closest of a known set", () => {
  it("names the id behind a typo", () => {
    expect(closest("dem", ["usecase-anysite", "demo", "usecase-login"])).toBe("demo");
  });

  it("names the topic behind a typo", () => {
    expect(closest("scriptng", ["overview", "scripting", "watching"])).toBe("scripting");
  });

  it("stays quiet when nothing is close", () => {
    expect(closest("zzzzzzzz", ["overview", "scripting"])).toBeUndefined();
  });

  it("has nothing to say about an empty set", () => {
    expect(closest("anything", [])).toBeUndefined();
  });
});
