import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScreencastError } from "../src/errors.js";
import {
  DEFAULT_BROWSER_ARGS,
  expandScenarioPattern,
  findConfigPath,
  loadConfig,
  loadScenarioFiles,
  resolveConfig,
  resolveConfigPath,
} from "../src/config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env["SCREENCAST_CONFIG"];
});

/**
 * A config file is the scale-up path, not the entry fee. Someone recording one
 * page of a site they do not own should not have to learn a config format
 * first, so the no-config defaults are a promise worth testing.
 */
describe("running without a config", () => {
  it("resolves usable defaults rooted at the working directory", async () => {
    const config = await loadConfig(undefined, dir);
    expect(config.configPath).toBeNull();
    expect(config.rootDir).toBe(resolve(dir));
    expect(config.outDir).toBe(join(resolve(dir), "screencasts"));
    expect(config.rawDir).toBe(join(resolve(dir), ".screencast/raw"));
    expect(config.scenarios).toEqual([]);
    expect(config.pace).toBe(1);
    expect(config.browser.headless).toBe(true);
    expect(config.browser.args).toEqual(DEFAULT_BROWSER_ARGS);
    expect(config.deliverables.width).toBe(1280);
  });
});

describe("locating the config", () => {
  it("walks up from a nested directory", () => {
    writeFileSync(join(dir, "screencast.config.mjs"), "export default {};");
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findConfigPath(nested)).toBe(join(dir, "screencast.config.mjs"));
  });

  it("returns null when there is none", () => {
    expect(findConfigPath(dir)).toBeNull();
  });

  it("honours SCREENCAST_CONFIG", () => {
    const file = join(dir, "custom.config.mjs");
    writeFileSync(file, "export default {};");
    process.env["SCREENCAST_CONFIG"] = file;
    expect(resolveConfigPath(undefined, dir)).toBe(file);
  });

  it("fails loudly when an explicit config is missing", () => {
    expect(() => resolveConfigPath("nope.config.ts", dir)).toThrowError(ScreencastError);
  });
});

/**
 * Relative paths anchor to the config file, not the shell's cwd - otherwise
 * the same command means different things from different directories in one
 * repo, which is the kind of bug nobody suspects.
 */
describe("path anchoring", () => {
  it("resolves relative paths against the config, not the cwd", () => {
    const configPath = join(dir, "sub", "screencast.config.ts");
    mkdirSync(join(dir, "sub"), { recursive: true });
    const config = resolveConfig({ outDir: "demos" }, configPath, "/somewhere/else");
    expect(config.outDir).toBe(join(dir, "sub", "demos"));
  });

  it("leaves absolute paths alone", () => {
    const config = resolveConfig({ outDir: "/tmp/fixed" }, join(dir, "c.ts"));
    expect(config.outDir).toBe("/tmp/fixed");
  });

  it("merges partial deliverables over the defaults", () => {
    const config = resolveConfig({ deliverables: { fps: 24 } }, null, dir);
    expect(config.deliverables.fps).toBe(24);
    expect(config.deliverables.width).toBe(1280);
  });
});

describe("expanding scenario patterns", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "scenarios", "nested"), { recursive: true });
    writeFileSync(join(dir, "scenarios", "a.ts"), "");
    writeFileSync(join(dir, "scenarios", "b.mts"), "");
    writeFileSync(join(dir, "scenarios", "notes.md"), "");
    writeFileSync(join(dir, "scenarios", "types.d.ts"), "");
    writeFileSync(join(dir, "scenarios", "nested", "c.ts"), "");
  });

  it("expands a star pattern and skips non-scenario files", () => {
    expect(expandScenarioPattern("scenarios/*.ts", dir)).toEqual([join(dir, "scenarios", "a.ts")]);
  });

  it("takes every scenario extension from a directory", () => {
    expect(expandScenarioPattern("scenarios", dir).map((f) => f.split("/").pop())).toEqual([
      "a.ts",
      "b.mts",
    ]);
  });

  it("recurses for a double star", () => {
    const found = expandScenarioPattern("scenarios/**/*.ts", dir);
    expect(found).toContain(join(dir, "scenarios", "nested", "c.ts"));
  });

  it("never picks up a declaration file", () => {
    expect(expandScenarioPattern("scenarios", dir).join()).not.toContain("types.d.ts");
  });

  it("returns nothing for a path that does not exist", () => {
    expect(expandScenarioPattern("missing/*.ts", dir)).toEqual([]);
  });
});

describe("loading scenarios", () => {
  const write = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };

  const SCENARIO = (id: string) => `
    const SCENARIO_MARKER = Symbol.for("screencast-axi.scenario");
    export default { id: ${JSON.stringify(id)}, title: "t", description: "d",
      run: async () => {}, [SCENARIO_MARKER]: true };
  `;

  it("finds a scenario in any export position", async () => {
    const named = write(
      "named.mjs",
      `const M = Symbol.for("screencast-axi.scenario");
       export const somethingElse = 42;
       export const clip = { id: "named", title: "t", description: "d",
         run: async () => {}, [M]: true };`,
    );
    const loaded = await loadScenarioFiles([named]);
    expect(loaded.map((l) => l.scenario.id)).toEqual(["named"]);
  });

  it("explains what to do when a module exports no scenario", async () => {
    const file = write("empty.mjs", "export const x = 1;");
    await expect(loadScenarioFiles([file])).rejects.toThrowError(/No scenario exported/);
  });

  it("rejects two scenarios sharing an id", async () => {
    // Ids are the output file stem, so a duplicate silently overwrites a clip.
    const a = write("a.mjs", SCENARIO("same"));
    const b = write("b.mjs", SCENARIO("same"));
    await expect(loadScenarioFiles([a, b])).rejects.toThrowError(/Duplicate scenario id/);
  });
});
