import { statSync } from "node:fs";
import { relative } from "node:path";
import { loadConfig } from "../config.js";
import { buildInventory, filesOf, summarise, type InventoryRow } from "../inventory.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import type { AxiStructuredOutput } from "../output.js";
import { ScreencastError } from "../errors.js";

export const LIST_FLAGS: FlagSpecs = {
  config: { kind: "string", description: "Path to a config file", placeholder: "path" },
  full: { kind: "boolean", description: "Every field, not the four-column summary" },
  stale: { kind: "boolean", description: "Only what needs re-shooting" },
  tag: { kind: "string", description: "Filter by scenario tag", placeholder: "name", repeat: true },
};

export const SHOW_FLAGS: FlagSpecs = {
  config: { kind: "string", description: "Path to a config file", placeholder: "path" },
  full: { kind: "boolean", description: "Include untruncated step text" },
};

function needsWork(row: InventoryRow): boolean {
  return row.status !== "recorded";
}

export async function listCommand(args: string[]): Promise<AxiStructuredOutput> {
  const { flags } = parseFlags(args, LIST_FLAGS);
  const config = await loadConfig(flags["config"] as string | undefined);
  const inventory = await buildInventory(config);
  const full = flags["full"] === true;

  const rows = flags["stale"] === true ? inventory.rows.filter(needsWork) : inventory.rows;

  if (rows.length === 0) {
    // Principle 5: an explicit nothing, never a blank list.
    return {
      scenarios: [],
      totals: flags["stale"] === true ? "0 scenarios need re-shooting" : "0 scenarios",
      help:
        inventory.rows.length === 0
          ? ["Create one: `screencast-axi scaffold <id> --url <url>`"]
          : ["Everything is up to date. `screencast-axi list` shows them all"],
    };
  }

  return {
    out: config.outDir,
    scenarios: rows.map((r) => ({
      id: r.id,
      status: r.status,
      steps: r.steps,
      duration_s: Number((r.durationMs / 1000).toFixed(1)),
      ...(full
        ? {
            title: r.title,
            file: relative(process.cwd(), r.file),
            ...(r.staleReason ? { why: r.staleReason } : {}),
            ...(r.missing.length > 0 ? { missing: r.missing } : {}),
            ...(r.entry?.recordedAt ? { recorded: r.entry.recordedAt } : {}),
          }
        : {}),
    })),
    totals: summarise(inventory),
    ...(inventory.orphans.length > 0 ? { orphaned: inventory.orphans.map((o) => o.id) } : {}),
    help: buildHelp(inventory, full),
  };
}

function buildHelp(inventory: Awaited<ReturnType<typeof buildInventory>>, full: boolean): string[] {
  const help: string[] = [];
  const first = inventory.rows.find(needsWork);
  if (first) {
    const why =
      first.status === "incomplete"
        ? `is missing ${first.missing.join(", ")}`
        : first.status === "stale"
          ? `is stale - its ${first.staleReason}`
          : "has never been recorded";
    help.push(`\`screencast-axi record ${first.id}\` - it ${why}`);
  }
  if (inventory.orphans.length > 0) {
    help.push("`screencast-axi check` explains the orphaned entries");
  }
  if (!full) help.push("Add `--full` for titles, file paths and recording dates");
  if (help.length === 0) help.push("Everything is recorded and current");
  return help;
}

export async function showCommand(args: string[]): Promise<AxiStructuredOutput> {
  const { positionals, flags } = parseFlags(args, SHOW_FLAGS);
  const id = positionals[0];

  const config = await loadConfig(flags["config"] as string | undefined);
  const inventory = await buildInventory(config);

  if (!id) {
    throw new ScreencastError("Name a scenario", "VALIDATION_ERROR", [
      "Run `screencast-axi show <id>`",
      inventory.rows.length > 0
        ? `This config has: ${inventory.rows.map((r) => r.id).join(", ")}`
        : "No scenarios are configured yet",
    ]);
  }

  const row = inventory.rows.find((r) => r.id === id);
  if (!row) {
    const orphan = inventory.orphans.find((o) => o.id === id);
    throw new ScreencastError(`Unknown scenario: ${id}`, "UNKNOWN_SCENARIO", [
      orphan
        ? `\`${id}\` is in the manifest but has no scenario any more - see \`screencast-axi check\``
        : `This config has: ${inventory.rows.map((r) => r.id).join(", ") || "nothing"}`,
    ]);
  }

  const files = filesOf(row, config.outDir).map((f) => ({
    file: f,
    kb: Math.round(statSync(f).size / 1024),
  }));

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    ...(row.staleReason ? { why: row.staleReason } : {}),
    scenario: relative(process.cwd(), row.file),
    ...(row.entry
      ? {
          description: row.entry.description,
          duration_s: Number((row.entry.durationMs / 1000).toFixed(1)),
          size: `${row.entry.width}x${row.entry.height}`,
          recorded: row.entry.recordedAt,
          ...(row.entry.device ? { device: row.entry.device } : {}),
          ...(row.entry.pace !== undefined ? { pace: row.entry.pace } : {}),
        }
      : {}),
    ...(row.entry?.steps ? { steps: row.entry.steps } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(row.missing.length > 0 ? { missing: row.missing } : {}),
    help:
      row.status === "recorded"
        ? [`\`screencast-axi record ${row.id}\` re-shoots it`]
        : [`\`screencast-axi rehearse ${row.id}\` first, then \`record ${row.id}\``],
  };
}
