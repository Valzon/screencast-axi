import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COMMAND_REFERENCE } from "../src/reference.js";
import { RECORD_FLAGS } from "../src/commands/record.js";

/**
 * A hand-maintained flag table stops being true the first time someone adds a
 * flag, and a stale reference is worse than none - so it is generated, and
 * these guard the generator itself.
 */
describe("the command reference", () => {
  const reference = COMMAND_REFERENCE();

  it("documents every flag `record` accepts", () => {
    for (const name of Object.keys(RECORD_FLAGS)) {
      expect(reference).toContain(`--${name}`);
    }
  });

  it("covers every command the CLI exposes", () => {
    const help = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const registered = [...help.matchAll(/^ {6}(\w[\w-]*): \(args\)/gm)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(5);
    for (const command of registered) {
      expect(reference).toContain(`#### \`${command}\``);
    }
  });

  it("is embedded in the README between its markers", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const start = readme.indexOf("<!-- reference:start -->");
    const end = readme.indexOf("<!-- reference:end -->");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Spot-check a flag actually made it through, not just the markers.
    expect(readme.slice(start, end)).toContain("--duration");
  });
});
