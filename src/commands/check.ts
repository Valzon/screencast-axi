import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { buildInventory } from "../inventory.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import { readManifest, writeManifest } from "../manifest.js";
import type { AxiStructuredOutput } from "../output.js";

export const CHECK_FLAGS: FlagSpecs = {
  config: { kind: "string", description: "Path to a config file", placeholder: "path" },
  "fix-orphans": {
    kind: "boolean",
    description: "Delete manifest entries and media with no scenario behind them",
  },
};

/**
 * Does the clip library hang together?
 *
 * The browser-free half of verifying a set of screencasts: manifest against
 * scenarios against the files on disk. Everything a page-level audit would
 * also check needs a browser and a built site, and belongs in whatever builds
 * that site - this part does not, and runs in milliseconds.
 */
export async function checkCommand(args: string[]): Promise<AxiStructuredOutput> {
  const { flags } = parseFlags(args, CHECK_FLAGS);
  const config = await loadConfig(flags["config"] as string | undefined);
  const inventory = await buildInventory(config);

  const failures: { problem: string; detail: string }[] = [];

  for (const p of inventory.problems) {
    failures.push({
      problem: "manifest entry is invalid",
      detail: p.index >= 0 ? `entry ${p.index}: ${p.reason}` : p.reason,
    });
  }
  for (const row of inventory.rows) {
    if (row.status === "incomplete") {
      failures.push({ problem: `${row.id} is missing files`, detail: row.missing.join(", ") });
    }
    if (row.status === "stale") {
      failures.push({ problem: `${row.id} is stale`, detail: row.staleReason ?? "changed" });
    }
    if (row.status === "never-recorded") {
      failures.push({ problem: `${row.id} has never been recorded`, detail: row.file });
    }
  }
  for (const orphan of inventory.orphans) {
    failures.push({
      problem: `${orphan.id} has no scenario`,
      detail: "in the manifest, but nothing in the config produces it any more",
    });
  }
  for (const stray of inventory.strays) {
    failures.push({
      problem: `${stray} is not in the manifest`,
      detail: "left over from a rename or a deleted scenario",
    });
  }

  if (
    flags["fix-orphans"] === true &&
    (inventory.orphans.length > 0 || inventory.strays.length > 0)
  ) {
    const removed: string[] = [];
    const { entries } = readManifest(config.outDir);
    const keep = entries.filter((e) => !inventory.orphans.some((o) => o.id === e.id));
    if (keep.length !== entries.length) {
      writeManifest(config.outDir, keep);
      removed.push(...inventory.orphans.map((o) => `${o.id} (manifest entry)`));
    }
    for (const orphan of inventory.orphans) {
      for (const ext of orphan.formats ?? ["mp4", "webm", "webp"]) {
        const file = join(config.outDir, `${orphan.id}.${ext}`);
        await rm(file, { force: true });
        removed.push(`${orphan.id}.${ext}`);
      }
    }
    for (const stray of inventory.strays) {
      await rm(join(config.outDir, stray), { force: true });
      removed.push(stray);
    }
    return {
      removed,
      totals: `${removed.length} removed`,
      help: ["Run `screencast-axi check` again to confirm the library is clean"],
    };
  }

  if (failures.length === 0) {
    return {
      checked: inventory.rows.length,
      result: "consistent",
      totals: `${inventory.rows.length} scenarios, manifest and files all agree`,
      help: ["Nothing to do"],
    };
  }

  return {
    failures,
    totals: `${failures.length} problem(s) across ${inventory.rows.length} scenarios`,
    help: [
      ...(inventory.rows.some((r) => r.status !== "recorded")
        ? ["`screencast-axi record --all --if-changed` re-shoots what has drifted"]
        : []),
      ...(inventory.orphans.length + inventory.strays.length > 0
        ? ["`screencast-axi check --fix-orphans` deletes what no scenario claims"]
        : []),
    ],
  };
}
