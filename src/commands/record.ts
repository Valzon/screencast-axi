import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig, loadScenarioFiles, loadScenarios, type ResolvedConfig } from "../config.js";
import { ScreencastError } from "../errors.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import type { AxiStructuredOutput } from "../output.js";
import { ScenarioFailure, runScenario, type RunMode, type RunResult } from "../run.js";
import { detectToolchain } from "../toolchain.js";
import type { DefinedScenario } from "../types.js";

const SHARED: FlagSpecs = {
  config: { kind: "string", description: "Path to a config file", placeholder: "path" },
  "base-url": {
    kind: "string",
    description: "Override the scenario's base URL",
    placeholder: "url",
  },
  pace: { kind: "number", description: "Speed multiplier; lower is faster" },
  device: { kind: "string", description: "Playwright device preset", placeholder: "name" },
  orientation: { kind: "string", description: "portrait or landscape", placeholder: "o" },
  headed: { kind: "boolean", description: "Show the browser while it runs" },
};

export const RECORD_FLAGS: FlagSpecs = {
  ...SHARED,
  out: { kind: "string", description: "Output directory", placeholder: "dir" },
  all: { kind: "boolean", description: "Record every scenario the config lists" },
  "keep-raw": { kind: "boolean", description: "Keep the raw capture for inspection" },
};

export const REHEARSE_FLAGS: FlagSpecs = SHARED;

interface Selected {
  readonly scenario: DefinedScenario;
  readonly file: string;
}

/**
 * Resolves ids or file paths to scenarios.
 *
 * A path is accepted as well as an id so a first run needs no config: someone
 * recording one page of a site they do not own should be able to write a file
 * and point at it.
 */
async function select(
  targets: readonly string[],
  config: ResolvedConfig,
  all: boolean,
): Promise<Selected[]> {
  const paths = targets.filter((t) => t.includes("/") || t.endsWith(".ts") || t.endsWith(".mjs"));
  const ids = targets.filter((t) => !paths.includes(t));

  const loaded = [
    ...(paths.length > 0
      ? await loadScenarioFiles(paths.map((p) => (isAbsolute(p) ? p : resolve(process.cwd(), p))))
      : []),
    ...(ids.length > 0 || all ? await loadScenarios(config) : []),
  ];

  if (all) return loaded;

  const chosen: Selected[] = [];
  for (const id of ids) {
    const match = loaded.find((l) => l.scenario.id === id);
    if (!match) {
      const known = loaded.map((l) => l.scenario.id);
      throw new ScreencastError(`Unknown scenario: ${id}`, "UNKNOWN_SCENARIO", [
        known.length > 0
          ? `This config knows: ${known.join(", ")}`
          : "No scenarios are configured. Create one with `screencast-axi scaffold <id>`",
        "You can also pass a file path instead of an id",
      ]);
    }
    chosen.push(match);
  }
  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
    for (const l of loaded.filter((l) => l.file === absolute)) chosen.push(l);
  }
  return chosen;
}

function orientationOf(value: unknown): "portrait" | "landscape" | undefined {
  if (value === undefined) return undefined;
  if (value !== "portrait" && value !== "landscape") {
    throw new ScreencastError(`--orientation must be portrait or landscape`, "VALIDATION_ERROR", [
      "Example: --orientation portrait",
    ]);
  }
  return value;
}

function describe(result: RunResult): AxiStructuredOutput {
  const files = result.encoded
    ? Object.entries(result.encoded.sizes).map(([name, bytes]) => ({
        file: name,
        kb: Math.round(bytes / 1024),
      }))
    : [];
  return {
    [result.mode === "record" ? "recorded" : "rehearsed"]: result.id,
    duration_s: Number((result.durationMs / 1000).toFixed(1)),
    pace: result.pace,
    viewport: `${result.viewport.viewport.width}x${result.viewport.viewport.height}`,
    ...(result.viewport.device ? { device: result.viewport.device } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(result.steps.length > 0 ? { steps: result.steps } : {}),
    ...(result.manifestPath ? { manifest: result.manifestPath } : {}),
  };
}

export async function recordCommand(args: string[], mode: RunMode): Promise<AxiStructuredOutput> {
  const specs = mode === "record" ? RECORD_FLAGS : REHEARSE_FLAGS;
  const { positionals, flags } = parseFlags(args, specs);
  const all = flags["all"] === true;

  if (positionals.length === 0 && !all) {
    throw new ScreencastError("Nothing to run", "VALIDATION_ERROR", [
      `Name a scenario: \`screencast-axi ${mode} <id>\``,
      `Or a file: \`screencast-axi ${mode} ./scenarios/tour.ts\``,
      "Or `--all` to run every scenario the config lists",
    ]);
  }

  const config = await loadConfig(flags["config"] as string | undefined);
  const selected = await select(positionals, config, all);

  if (selected.length === 0) {
    return { [mode]: [], totals: "0 scenarios matched", help: ["Run `screencast-axi list`"] };
  }

  // Probed once for the batch rather than per clip, and before any browser
  // opens - a missing ffmpeg should not cost a forty-second take first.
  const toolchain = mode === "record" ? await detectToolchain() : undefined;

  const orientation = orientationOf(flags["orientation"]);

  const results: RunResult[] = [];
  for (const { scenario, file } of selected) {
    const sourceText = await readFile(file, "utf8").catch(() => undefined);
    results.push(
      await runScenario({
        scenario,
        config,
        mode,
        ...(sourceText ? { sourceText } : {}),
        ...(flags["base-url"] ? { baseUrl: flags["base-url"] as string } : {}),
        ...(flags["out"] ? { outDir: resolve(process.cwd(), flags["out"] as string) } : {}),
        ...(flags["pace"] !== undefined ? { pace: flags["pace"] as number } : {}),
        ...(flags["device"] ? { device: flags["device"] as string } : {}),
        ...(orientation ? { orientation } : {}),
        ...(flags["headed"] === true ? { headed: true } : {}),
        ...(flags["keep-raw"] === true ? { keepRaw: true } : {}),
        ...(toolchain ? { toolchain } : {}),
        // stderr: stdout stays reserved for the final payload.
        log: (message) => process.stderr.write(`${message}\n`),
      }),
    );
  }

  if (results.length === 1) {
    return { ...describe(results[0] as RunResult), help: nextSteps(results[0] as RunResult) };
  }

  return {
    [mode === "record" ? "recorded" : "rehearsed"]: results.map((r) => ({
      id: r.id,
      duration_s: Number((r.durationMs / 1000).toFixed(1)),
    })),
    totals: `${results.length} scenarios`,
    help: [`Run \`screencast-axi show <id>\` for one clip in full`],
  };
}

function nextSteps(result: RunResult): string[] {
  if (result.mode === "rehearse") {
    return [
      `Selectors and narration hold. Run \`screencast-axi record ${result.id}\` for the real take`,
      "A rehearsal runs faster than a take, so it can trip on an animation a recording would wait out",
    ];
  }
  return [
    `The clip is ${(result.durationMs / 1000).toFixed(1)}s. Re-cut it with \`screencast-axi record ${result.id} --pace 0.8\` (lower is faster)`,
    result.manifestPath
      ? `Title, description and steps are in ${relative(process.cwd(), result.manifestPath)} for a site to read`
      : "",
  ].filter(Boolean);
}

export { ScenarioFailure };
