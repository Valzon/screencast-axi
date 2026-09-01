import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInventory, summarise } from "../src/inventory.js";
import { resolveConfig } from "../src/config.js";
import { hashSteps, hashText, writeManifest, type ManifestEntry } from "../src/manifest.js";

let dir: string;

const SCENARIO = (id: string, steps: string[]) => `
const M = Symbol.for("screencast-axi.scenario");
export default { id: ${JSON.stringify(id)}, title: "t", description: "d",
  steps: ${JSON.stringify(steps)}, run: async () => {}, [M]: true };
`;

function scenario(id: string, steps: string[] = ["one"]): string {
  const file = join(dir, "scenarios", `${id}.mjs`);
  writeFileSync(file, SCENARIO(id, steps));
  return file;
}

function entry(id: string, over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    id,
    title: "t",
    description: "d",
    width: 1280,
    height: 800,
    durationMs: 10_000,
    recordedAt: "2026-08-31T00:00:00.000Z",
    formats: ["mp4", "webm", "webp"],
    ...over,
  };
}

/** The deliverables an entry claims, so it is not reported as incomplete. */
function media(id: string, formats = ["mp4", "webm", "webp"]): void {
  for (const f of formats) writeFileSync(join(dir, "out", `${id}.${f}`), "x");
}

const config = () =>
  resolveConfig(
    { scenarios: ["scenarios/*.mjs"], outDir: "out" },
    join(dir, "screencast.config.ts"),
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inv-"));
  mkdirSync(join(dir, "scenarios"), { recursive: true });
  mkdirSync(join(dir, "out"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("what needs re-shooting", () => {
  it("reports a scenario with no clip", async () => {
    scenario("alpha");
    const inv = await buildInventory(config());
    expect(inv.rows[0]).toMatchObject({ id: "alpha", status: "never-recorded" });
  });

  it("reports a clip whose narration has changed", async () => {
    // The caption on screen no longer matches what the scenario says, which
    // makes the clip actively wrong rather than merely dated.
    scenario("alpha", ["new wording"]);
    writeManifest(join(dir, "out"), [entry("alpha", { stepsHash: hashSteps(["old wording"]) })]);
    media("alpha");
    const inv = await buildInventory(config());
    expect(inv.rows[0]).toMatchObject({ status: "stale", staleReason: "narration changed" });
  });

  it("reports a clip whose scenario source has changed", async () => {
    const file = scenario("alpha");
    writeManifest(join(dir, "out"), [
      entry("alpha", { stepsHash: hashSteps(["one"]), sourceHash: hashText("something else") }),
    ]);
    media("alpha");
    const inv = await buildInventory(config());
    expect(inv.rows[0]).toMatchObject({ status: "stale", staleReason: "scenario changed" });
    expect(inv.rows[0]?.file).toBe(file);
  });

  it("calls a clip current when both hashes match", async () => {
    const file = scenario("alpha");
    writeManifest(join(dir, "out"), [
      entry("alpha", {
        stepsHash: hashSteps(["one"]),
        sourceHash: hashText(SCENARIO("alpha", ["one"])),
      }),
    ]);
    media("alpha");
    void file;
    const inv = await buildInventory(config());
    expect(inv.rows[0]?.status).toBe("recorded");
  });

  it("a missing file outranks a stale hash", async () => {
    // The clip is not merely dated, it is not all there.
    scenario("alpha", ["changed"]);
    writeManifest(join(dir, "out"), [entry("alpha", { stepsHash: hashSteps(["old"]) })]);
    media("alpha", ["mp4"]);
    const inv = await buildInventory(config());
    expect(inv.rows[0]?.status).toBe("incomplete");
    expect(inv.rows[0]?.missing).toEqual(["alpha.webm", "alpha.webp"]);
  });
});

describe("things with nothing behind them", () => {
  it("reports a manifest entry whose scenario is gone", async () => {
    scenario("alpha");
    writeManifest(join(dir, "out"), [entry("alpha"), entry("deleted")]);
    media("alpha");
    const inv = await buildInventory(config());
    expect(inv.orphans.map((o) => o.id)).toEqual(["deleted"]);
  });

  it("reports media no entry claims", async () => {
    scenario("alpha");
    writeManifest(join(dir, "out"), [entry("alpha")]);
    media("alpha");
    writeFileSync(join(dir, "out", "leftover.gif"), "x");
    const inv = await buildInventory(config());
    expect(inv.strays).toEqual(["leftover.gif"]);
  });

  it("does not mistake an animated webp for a leftover", async () => {
    // Regression: it shares the `.webp` extension with the poster, so a
    // check keyed on extension reported it as unclaimed - and --fix-orphans
    // then deleted a file the clip needed.
    scenario("alpha");
    writeManifest(join(dir, "out"), [
      entry("alpha", { formats: ["mp4", "webm", "webp", "gif", "anim.webp"] }),
    ]);
    media("alpha", ["mp4", "webm", "webp", "gif", "anim.webp"]);
    const inv = await buildInventory(config());
    expect(inv.strays).toEqual([]);
    expect(inv.rows[0]?.status).toBe("recorded");
  });
});

describe("summary line", () => {
  it("says nothing rather than showing an empty list", async () => {
    expect(summarise(await buildInventory(config()))).toBe("0 scenarios");
  });

  it("counts each state", async () => {
    scenario("alpha");
    scenario("beta");
    writeManifest(join(dir, "out"), [entry("alpha", { stepsHash: hashSteps(["one"]) })]);
    media("alpha");
    const line = summarise(await buildInventory(config()));
    expect(line).toContain("2 scenarios");
    expect(line).toContain("1 never-recorded");
  });
});
