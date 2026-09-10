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

/**
 * Both of these shipped broken in 0.1.0 and made the documented first run
 * fail on the commonest project shape: `npm init -y` (so CommonJS) plus
 * `npx -y screencast-axi` (so the CLI runs from npx's cache, not the project).
 */
describe("loading a scenario from a CommonJS project", () => {
  it("finds a scenario behind CJS interop wrapping", async () => {
    // What `import()` hands back when TypeScript is compiled to CJS: the
    // export is at default.default, not default.
    const file = join(dir, "wrapped.cjs");
    writeFileSync(
      file,
      `const M = Symbol.for("screencast-axi.scenario");
       exports.__esModule = true;
       exports.default = { id: "wrapped", title: "t", description: "d",
         run: async () => {}, [M]: true };`,
    );
    const loaded = await loadScenarioFiles([file]);
    expect(loaded.map((l) => l.scenario.id)).toEqual(["wrapped"]);
  });

  it("still finds a plain ESM default export", async () => {
    const file = join(dir, "plain.mjs");
    writeFileSync(
      file,
      `const M = Symbol.for("screencast-axi.scenario");
       export default { id: "plain", title: "t", description: "d",
         run: async () => {}, [M]: true };`,
    );
    const loaded = await loadScenarioFiles([file]);
    expect(loaded.map((l) => l.scenario.id)).toEqual(["plain"]);
  });

  it("counts one scenario once when interop exposes it twice", async () => {
    // `default` and `module.exports` are the same object; treating them as
    // two scenarios made a valid file fail as a duplicate id.
    const file = join(dir, "twice.cjs");
    writeFileSync(
      file,
      `const M = Symbol.for("screencast-axi.scenario");
       const s = { id: "twice", title: "t", description: "d",
         run: async () => {}, [M]: true };
       exports.__esModule = true;
       exports.default = s;`,
    );
    const loaded = await loadScenarioFiles([file]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.scenario.id).toBe("twice");
  });

  it("reads a config exported through CJS interop", async () => {
    const configPath = join(dir, "screencast.config.cjs");
    writeFileSync(
      configPath,
      `exports.__esModule = true;
       exports.default = { outDir: "from-cjs", baseUrl: "https://cjs.example" };`,
    );
    const config = await loadConfig(configPath, dir);
    expect(config.baseUrl).toBe("https://cjs.example");
    expect(config.outDir).toBe(join(dir, "from-cjs"));
  });
});

/**
 * A scaffolded scenario opens by importing this package, and that specifier
 * resolves from the scenario's own project. Run the CLI through `npx` and the
 * package sits in a cache directory instead, so the import fails on a machine
 * where the command itself plainly works.
 */
describe("a file that imports this package", () => {
  it("says the project is missing it, rather than naming an unknown module", async () => {
    const file = join(dir, "scenario.mjs");
    writeFileSync(file, `import { defineScenario } from "screencast-axi";\nexport default {};\n`);

    const error = await loadScenarioFiles([file]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScreencastError);
    expect((error as ScreencastError).code).toBe("SELF_NOT_INSTALLED");
    expect((error as ScreencastError).message).toContain("screencast-axi");
    expect((error as ScreencastError).suggestions.join(" ")).toContain(
      "pnpm add -D screencast-axi",
    );
  });

  it("leaves an unrelated missing import alone", async () => {
    const file = join(dir, "other.mjs");
    writeFileSync(file, `import "totally-absent-package";\nexport default {};\n`);

    const error = await loadScenarioFiles([file]).catch((e: unknown) => e);

    expect((error as { code?: string }).code).not.toBe("SELF_NOT_INSTALLED");
  });
});
