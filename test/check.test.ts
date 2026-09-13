import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand } from "../src/commands/check.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { FailingReport, ScreencastError } from "../src/errors.js";
import { writeManifest, type ManifestEntry } from "../src/manifest.js";

let dir: string;
let cwd: string;

const SCENARIO = (id: string) => `
export default { id: ${JSON.stringify(id)}, title: "t", description: "d",
  steps: ["one"], run: async () => {} };
`;

function entry(id: string): ManifestEntry {
  return {
    id,
    title: "t",
    description: "d",
    width: 1280,
    height: 800,
    durationMs: 10_000,
    recordedAt: "2026-09-13T00:00:00.000Z",
    formats: ["mp4", "webm", "webp"],
  };
}

function media(id: string): void {
  for (const ext of ["mp4", "webm", "webp"]) {
    writeFileSync(join(dir, "screencasts", `${id}.${ext}`), "x");
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-"));
  mkdirSync(join(dir, "scenarios"), { recursive: true });
  mkdirSync(join(dir, "screencasts"), { recursive: true });
  writeFileSync(
    join(dir, "screencast.config.mjs"),
    `export default { scenarios: ["scenarios/*.mjs"], outDir: "screencasts" };`,
  );
  cwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const config = ["--config", "screencast.config.mjs"];

/**
 * An unreadable manifest claims nothing, so everything on disk looks
 * unclaimed - and deleting what nothing claims is exactly this flag's job. It
 * took the whole clip library, without confirmation, exit 0, and `check`
 * itself printed the command that did it.
 */
describe("deleting what no scenario claims", () => {
  it("refuses outright when the manifest cannot be read", async () => {
    writeFileSync(join(dir, "screencasts", "manifest.json"), "not json at all");
    media("alpha");

    const error = await checkCommand([...config, "--fix-orphans"]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScreencastError);
    expect((error as ScreencastError).code).toBe("MANIFEST_UNREADABLE");
    expect(existsSync(join(dir, "screencasts", "alpha.mp4"))).toBe(true);
  });

  it("deletes nothing under --dry-run, and says what it would take", async () => {
    writeManifest(join(dir, "screencasts"), [entry("gone")]);
    media("gone");

    const out = await checkCommand([...config, "--fix-orphans", "--dry-run"]);

    expect(out["would_remove"]).toContain("gone.mp4");
    expect(existsSync(join(dir, "screencasts", "gone.mp4"))).toBe(true);
  });

  it("deletes them without --dry-run", async () => {
    writeManifest(join(dir, "screencasts"), [entry("gone")]);
    media("gone");

    await checkCommand([...config, "--fix-orphans"]);

    expect(existsSync(join(dir, "screencasts", "gone.mp4"))).toBe(false);
  });
});

/**
 * Both commands answer a question, and the answer can be "this is broken".
 * Returning that and exiting 0 meant a CI step running either of them passed
 * while the tool was listing what was wrong.
 */
describe("the status a report exits with", () => {
  it("is zero when the library agrees with itself", async () => {
    writeFileSync(join(dir, "scenarios", "alpha.mjs"), SCENARIO("alpha"));
    writeManifest(join(dir, "screencasts"), [entry("alpha")]);
    media("alpha");

    const out = await checkCommand(config);
    expect(out["result"]).toBe("consistent");
  });

  it("is non-zero when it is not, with the same report as before", async () => {
    writeFileSync(join(dir, "scenarios", "alpha.mjs"), SCENARIO("alpha"));

    const error = await checkCommand(config).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FailingReport);
    const payload = (error as FailingReport).payload;
    expect(Array.isArray(payload["failures"])).toBe(true);
    expect(String(payload["totals"])).toContain("problem");
  });

  // Launches a browser to verify it, like every other check it makes, so it
  // gets the same budget as the rest of the suite's browser tests.
  it("is zero for a machine that can record", async () => {
    const out = await doctorCommand([]);
    expect(out["ready"]).toBe(true);
  }, 60_000);
});
