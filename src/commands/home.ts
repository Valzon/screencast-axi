import { readManifest } from "../manifest.js";
import { loadConfig, loadScenarios } from "../config.js";
import type { AxiStructuredOutput } from "../output.js";

type Status = "recorded" | "stale" | "never-recorded";

/**
 * The no-argument view: live data, never help text (AXI principle 8).
 *
 * `status` is the aggregate worth pre-computing. Deriving it otherwise means
 * reading the manifest, listing the output directory and diffing both against
 * the scenario list - three round trips to answer the question anyone actually
 * has, which is "what do I need to re-shoot".
 *
 * The SDK prepends `{ bin, description }`, so this returns only the state.
 */
export async function homeView(): Promise<AxiStructuredOutput> {
  const config = await loadConfig().catch(() => null);

  if (!config) {
    return {
      config: "none",
      scenarios: [],
      totals: "0 scenarios",
      help: [
        "Create one: `screencast-axi scaffold <id> --url <url>`",
        "Run `screencast-axi guide` for topic-sized guidance",
      ],
    };
  }

  const loaded = await loadScenarios(config).catch(() => []);
  const { entries } = readManifest(config.outDir);
  const byId = new Map(entries.map((e) => [e.id, e]));

  const rows = loaded.map(({ scenario }) => {
    const entry = byId.get(scenario.id);
    const status: Status = !entry
      ? "never-recorded"
      : entry.stepsHash && entry.steps?.join("\u0000") !== scenario.steps?.join("\u0000")
        ? "stale"
        : "recorded";
    return {
      id: scenario.id,
      status,
      steps: scenario.steps?.length ?? 0,
      duration_s: entry ? Number((entry.durationMs / 1000).toFixed(1)) : 0,
    };
  });

  const counts = rows.reduce<Record<Status, number>>(
    (acc, r) => ({ ...acc, [r.status]: acc[r.status] + 1 }),
    { recorded: 0, stale: 0, "never-recorded": 0 },
  );

  const orphans = entries.filter((e) => !loaded.some((l) => l.scenario.id === e.id));

  return {
    config: config.configPath ?? "none",
    out: config.outDir,
    scenarios: rows,
    totals:
      rows.length === 0
        ? "0 scenarios"
        : `${rows.length} scenarios, ${counts.recorded} recorded, ${counts.stale} stale, ${counts["never-recorded"]} never-recorded`,
    ...(orphans.length > 0 ? { orphaned: orphans.map((o) => o.id) } : {}),
    help: buildHelp(rows, orphans.length),
  };
}

function buildHelp(rows: readonly { id: string; status: Status }[], orphans: number): string[] {
  if (rows.length === 0) {
    return [
      "No scenarios found. Create one: `screencast-axi scaffold <id> --url <url>`",
      "A scenario can also be recorded straight from a path, with no config",
    ];
  }
  const help: string[] = [];
  const stale = rows.find((r) => r.status === "stale");
  const never = rows.find((r) => r.status === "never-recorded");
  if (stale) {
    help.push(
      `\`screencast-axi record ${stale.id}\` - its narration changed since the clip was shot`,
    );
  }
  if (never) {
    help.push(`\`screencast-axi record ${never.id}\` - never recorded`);
  }
  if (orphans > 0) {
    help.push(`${orphans} clip(s) in the output directory have no scenario any more`);
  }
  help.push("Iterate with `rehearse` rather than `record`: it skips the encode");
  return help;
}
