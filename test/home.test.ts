import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeView } from "../src/commands/home.js";

let dir: string;
let previousCwd: string;
beforeEach(() => {
  previousCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "home-"));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The no-argument view is the first thing anyone runs, and for a while it
 * answered a broken config the same way it answered no config at all: `config:
 * none`, plus advice to create one. That sends someone to write a second file
 * beside the one that is already failing.
 */
describe("the no-argument view", () => {
  it("reports having no config as having none", async () => {
    const view = await homeView();

    expect(view["config"]).toBe("none");
    expect(view["error"]).toBeUndefined();
    expect(String(view["help"])).toContain("scaffold");
  });

  it("names the config it found and why it would not load", async () => {
    writeFileSync(join(dir, "screencast.config.mjs"), "throw new Error('kaboom');\n");

    const view = await homeView();

    expect(view["config"]).toContain("screencast.config.mjs");
    expect(view["config"]).not.toBe("none");
    expect(String(view["error"])).toContain("kaboom");
    expect(String(view["help"])).not.toContain("scaffold");
  });

  it("names a scenario file that would not load, rather than showing none", async () => {
    writeFileSync(
      join(dir, "screencast.config.mjs"),
      "export default { scenarios: ['scenarios/*.mjs'] };\n",
    );
    mkdirSync(join(dir, "scenarios"));
    writeFileSync(join(dir, "scenarios", "broken.mjs"), "throw new Error('bad scenario');\n");

    const view = await homeView();

    expect(view["config"]).toContain("screencast.config.mjs");
    expect(String(view["error"])).toContain("bad scenario");
    expect(String(view["help"])).not.toContain("scaffold");
  });
});
