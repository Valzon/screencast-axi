import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFromProject } from "../src/resolve.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "resolve-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a throwaway package into `dir`'s node_modules. */
function install(name: string, files: Record<string, string>): void {
  const root = join(dir, "node_modules", name);
  mkdirSync(root, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    writeFileSync(join(root, file), contents);
  }
}

/**
 * Optional dependencies belong to the consuming project, not to this package.
 * Under `npx screencast-axi` this module sits in a cache directory that has
 * none of them, so resolution anchored on our own location reports a
 * dependency missing on a project that installed it.
 */
describe("importing a project's packages", () => {
  it("loads the copy the project installed", async () => {
    install("pretend-dep", {
      "package.json": JSON.stringify({ name: "pretend-dep", version: "1.0.0", main: "index.js" }),
      "index.js": "module.exports = { marker: 'from-project' };",
    });

    const loaded = await importFromProject<{ marker: string }>("pretend-dep", () => true, dir);

    expect(loaded?.marker).toBe("from-project");
  });

  it("returns null when the project does not have it", async () => {
    const loaded = await importFromProject("definitely-not-installed-anywhere", () => true, dir);

    expect(loaded).toBeNull();
  });

  /**
   * The rung that proves the ladder's order. Importing the file that
   * `require.resolve` picks re-exports only the names a static lexer can spot,
   * which for Playwright finds its internals and misses `chromium` - so a
   * module that loads is not yet a module that is usable.
   */
  it("skips a rung that loads but has the wrong shape", async () => {
    install("shape-shifter", {
      "package.json": JSON.stringify({ name: "shape-shifter", version: "1.0.0", main: "index.js" }),
      "index.js": "module.exports = { internals: true };",
    });

    const loaded = await importFromProject<{ wanted?: boolean }>(
      "shape-shifter",
      (module) => module.wanted === true,
      dir,
    );

    expect(loaded).toBeNull();
  });

  it("accepts a CommonJS package by its real exports", async () => {
    // `require` leads the ladder precisely so this shape survives.
    install("cjs-dep", {
      "package.json": JSON.stringify({ name: "cjs-dep", version: "1.0.0", main: "index.js" }),
      "index.js": "exports.chromium = { launch() {} };",
    });

    const loaded = await importFromProject<{ chromium?: object }>(
      "cjs-dep",
      (module) => Boolean(module.chromium),
      dir,
    );

    expect(loaded?.chromium).toBeTypeOf("object");
  });

  it("loads an ESM-only package the project installed", async () => {
    install("esm-dep", {
      "package.json": JSON.stringify({
        name: "esm-dep",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
      "index.js": "export const marker = 'esm';",
    });

    const loaded = await importFromProject<{ marker?: string }>(
      "esm-dep",
      (module) => module.marker === "esm",
      dir,
    );

    expect(loaded?.marker).toBe("esm");
  });
});

/**
 * The third instance of the same root cause, found by grepping for what the
 * first two fixes had left behind.
 *
 * `ffmpeg-static` is the documented escape hatch for someone who would rather
 * not install ffmpeg system-wide - so resolving it from this package's own
 * location reported ffmpeg missing to precisely the people who had installed
 * it so that it would not be.
 */
describe("ffmpeg-static", () => {
  it("is looked up in the project, not beside this package", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ffstatic-"));
    try {
      const pkgDir = join(dir, "node_modules", "ffmpeg-static");
      mkdirSync(pkgDir, { recursive: true });
      // A stand-in that reports a path, which is all resolveFfmpeg reads.
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "ffmpeg-static", version: "1.0.0", main: "index.js" }),
      );
      writeFileSync(join(pkgDir, "index.js"), `module.exports = "/nonexistent/ffmpeg";`);

      const found = await importFromProject<{ default?: unknown }>(
        "ffmpeg-static",
        (m) => typeof m.default === "string",
        dir,
      );
      expect(found?.default).toBe("/nonexistent/ffmpeg");

      // And nothing is found from a directory that does not have it.
      const empty = mkdtempSync(join(tmpdir(), "noffstatic-"));
      try {
        const missing = await importFromProject<{ default?: unknown }>(
          "ffmpeg-static",
          (m) => typeof m.default === "string",
          empty,
        );
        expect(missing).toBeNull();
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
