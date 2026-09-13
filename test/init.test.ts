import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/commands/setup.js";
import { loadScenarioFiles } from "../src/config.js";

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "init-"));
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * `init` exists to set a project up, and the project it sets up is very often
 * one running the CLI through `npx` with nothing installed locally. The
 * generated config used to open with a runtime `import { defineConfig }`,
 * which resolves from the *user's* project - so `init` reported success and
 * every command that reads a config then failed with SELF_NOT_INSTALLED.
 */
describe("the config init writes", () => {
  it("imports only types, so it loads with the package uninstalled", () => {
    initCommand(["--url", "https://example.com"]);
    const written = readFileSync(join(dir, "screencast.config.ts"), "utf8");

    expect(written).toContain('import type { ScreencastConfig } from "screencast-axi"');
    expect(written).toContain("satisfies ScreencastConfig");
    // The failure itself: any value import of this package at the top level.
    expect(written).not.toMatch(/^import\s+\{/m);
  });

  it("does not trip the self-import failure the loader reports", async () => {
    initCommand(["--url", "https://example.com"]);
    // Renamed to .mts so the loader reads it as TypeScript without a config
    // lookup; the import form under test is identical either way.
    const file = join(dir, "config-under-test.mts");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, readFileSync(join(dir, "screencast.config.ts"), "utf8"));

    const error = await loadScenarioFiles([file]).catch((e: unknown) => e);

    // It is not a scenario, so it fails - but on having no scenario in it,
    // never on being unable to resolve `screencast-axi` at runtime.
    expect((error as { code?: string }).code).not.toBe("SELF_NOT_INSTALLED");
  });
});
