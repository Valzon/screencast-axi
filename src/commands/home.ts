import { readManifest } from "../manifest.js";
import { loadConfig, loadScenarios, resolveConfigPath, type ResolvedConfig } from "../config.js";
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
  // A config that exists but throws is a different state from having none, and
  // the difference is the whole answer: telling someone with a broken config to
  // create one sends them to write a second file beside the one that is failing.
  const configPath = resolveConfigPath();
  let config: ResolvedConfig | null = null;
  let configError: string | null = null;
  try {
    config = await loadConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  if (!config) {
    return {
      config: configPath ?? "none",
      ...(configError ? { error: configError } : {}),
      scenarios: [],
      totals: "0 scenarios",
      help: configError
        ? [
            "The config above was found but could not be loaded - the error says why",
            "Run `screencast-axi doctor` for the full diagnosis",
          ]
        : [
            "Create one: `screencast-axi scaffold <id> --url <url>`",
            "Run `screencast-axi guide` for topic-sized guidance",
          ],
    };
  }

  // Scenario files fail one at a time and for their own reasons, so a broken
  // one is reported as itself rather than collapsing the whole list to empty.
  let loaded: Awaited<ReturnType<typeof loadScenarios>> = [];
  let scenarioError: string | null = null;
  try {
    loaded = await loadScenarios(config);
  } catch (error) {
    scenarioError = error instanceof Error ? error.message : String(error);
  }
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
    ...(scenarioError ? { error: scenarioError } : {}),
    out: config.outDir,
    scenarios: rows,
    totals:
      rows.length === 0
        ? "0 scenarios"
        : `${rows.length} scenarios, ${counts.recorded} recorded, ${counts.stale} stale, ${counts["never-recorded"]} never-recorded`,
    ...(orphans.length > 0 ? { orphaned: orphans.map((o) => o.id) } : {}),
    help: buildHelp(rows, orphans.length, scenarioError),
  };
}

function buildHelp(
  rows: readonly { id: string; status: Status }[],
  orphans: number,
  scenarioError: string | null,
): string[] {
  if (scenarioError) {
    return [
      "The scenario files matched by the config could not be loaded - the error says why",
      "Run `screencast-axi list` to see the failure on its own",
    ];
  }
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
