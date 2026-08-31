import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clipFilesFor,
  hashSteps,
  missingFiles,
  readManifest,
  upsertEntry,
  validateManifest,
  writeManifest,
  type ManifestEntry,
} from "../src/manifest.js";

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id: "task-create",
  title: "Create a task",
  description: "Adding work to the board",
  width: 1280,
  height: 800,
  durationMs: 16_733,
  recordedAt: "2026-08-30T20:49:22.857Z",
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "manifest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reading", () => {
  it("treats a missing manifest as empty, not an error", () => {
    expect(readManifest(dir)).toEqual({ entries: [], problems: [] });
  });

  it("reports unparseable JSON without throwing", () => {
    writeFileSync(join(dir, "manifest.json"), "{ not json");
    const result = readManifest(dir);
    expect(result.entries).toEqual([]);
    expect(result.problems[0]?.reason).toContain("not valid JSON");
  });
});

/**
 * A half-written manifest should cost the clips it mangled, not the page: a
 * site rendering four good clips and falling back for a fifth beats one that
 * throws during a build.
 */
describe("validation keeps the good entries", () => {
  it("drops a malformed entry and keeps the rest", () => {
    const result = validateManifest([entry(), { id: "broken" }, entry({ id: "second" })]);
    expect(result.entries.map((e) => e.id)).toEqual(["task-create", "second"]);
    expect(result.problems).toEqual([{ index: 1, reason: "missing or empty `title`" }]);
  });

  it("rejects a duplicate id", () => {
    const result = validateManifest([entry(), entry()]);
    expect(result.entries).toHaveLength(1);
    expect(result.problems[0]?.reason).toContain("duplicate id");
  });

  it("rejects a non-numeric duration", () => {
    const result = validateManifest([entry({ durationMs: "16s" as unknown as number })]);
    expect(result.problems[0]?.reason).toContain("`durationMs` is not a number");
  });

  it("rejects a manifest that is not an array", () => {
    expect(validateManifest({ id: "x" }).problems[0]?.reason).toBe("manifest is not an array");
  });
});

describe("writing", () => {
  it("sorts by id so a reshoot is a minimal diff", () => {
    writeManifest(dir, [entry({ id: "zebra" }), entry({ id: "apple" })]);
    expect(readManifest(dir).entries.map((e) => e.id)).toEqual(["apple", "zebra"]);
  });

  it("replaces one entry and leaves the others alone", () => {
    writeManifest(dir, [entry({ id: "a" }), entry({ id: "b", title: "keep me" })]);
    upsertEntry(dir, entry({ id: "a", title: "reshot" }));
    const entries = readManifest(dir).entries;
    expect(entries.map((e) => e.title)).toEqual(["reshot", "keep me"]);
  });

  it("round-trips every optional field", () => {
    const full = entry({ steps: ["one", "two"], pace: 0.8, device: "iPhone 13", sourceHash: "ab" });
    writeManifest(dir, [full]);
    expect(readManifest(dir).entries[0]).toEqual(full);
  });
});

/**
 * The poster extension has to follow what was written. A machine with no WebP
 * encoder produces a PNG, and a consumer that assumed `.webp` would link a
 * file that is not there.
 */
describe("clip files", () => {
  it("defaults to a webp poster", () => {
    expect(clipFilesFor(entry(), dir).poster).toBe(join(dir, "task-create.webp"));
  });

  it("follows a PNG fallback recorded in formats", () => {
    const e = entry({ formats: ["mp4", "webm", "png"] });
    expect(clipFilesFor(e, dir).poster).toBe(join(dir, "task-create.png"));
  });

  it("includes a gif only when one was written", () => {
    expect(clipFilesFor(entry(), dir).gif).toBeUndefined();
    expect(clipFilesFor(entry({ formats: ["mp4", "webm", "webp", "gif"] }), dir).gif).toBe(
      join(dir, "task-create.gif"),
    );
  });

  it("names what is missing from disk", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task-create.mp4"), "x");
    expect(missingFiles(entry(), dir)).toEqual(["task-create.webm", "task-create.webp"]);
  });
});

describe("hashing", () => {
  it("is stable and order-sensitive", () => {
    expect(hashSteps(["a", "b"])).toBe(hashSteps(["a", "b"]));
    expect(hashSteps(["a", "b"])).not.toBe(hashSteps(["b", "a"]));
  });

  it("distinguishes absent steps from empty steps consistently", () => {
    expect(hashSteps(undefined)).toBe(hashSteps([]));
  });
});
