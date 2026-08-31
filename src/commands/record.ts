import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig, loadScenarioFiles, loadScenarios, type ResolvedConfig } from "../config.js";
import { ScreencastError } from "../errors.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import type { AxiStructuredOutput } from "../output.js";
import { ScenarioFailure, runScenario, type RunMode, type RunResult } from "../run.js";
import { parseDuration, solvePace, type PaceSolution } from "../duration.js";
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
  viewport: { kind: "string", description: "Explicit size, e.g. 390x844", placeholder: "WxH" },
  orientation: { kind: "string", description: "portrait or landscape", placeholder: "o" },
  headed: { kind: "boolean", description: "Watch it happen in a real browser window" },
  auth: { kind: "string", description: "Named auth strategy from the config", placeholder: "name" },
  "no-auth": { kind: "boolean", description: "Record signed out" },
};

export const RECORD_FLAGS: FlagSpecs = {
  ...SHARED,
  duration: {
    kind: "string",
    description: "Aim for this length, e.g. 30s (measures first, then solves for pace)",
    placeholder: "30s",
  },
  out: { kind: "string", description: "Output directory", placeholder: "dir" },
  all: { kind: "boolean", description: "Record every scenario the config lists" },
  full: { kind: "boolean", description: "Include the full action log" },
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

function viewportOf(value: unknown): { width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(value).trim());
  if (!match) {
    throw new ScreencastError(`--viewport must look like 1280x800`, "VALIDATION_ERROR", [
      "Example: --viewport 390x844",
      'Or use a device preset: --device "iPhone 13"',
    ]);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
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

/**
 * The action log, trimmed for reading.
 *
 * Full detail is behind `--full`: a long tour is dozens of lines, and the
 * point of the short form is that someone can scan it.
 */
function performed(result: RunResult, full: boolean): AxiStructuredOutput[] {
  const rows = result.performed.map((a) => ({
    at_s: Number((a.atMs / 1000).toFixed(1)),
    did: a.kind,
    ...(a.target ? { target: truncate(a.target, full) } : {}),
    ...(a.detail ? { detail: truncate(a.detail, full) } : {}),
  }));
  return full ? rows : rows.slice(0, 24);
}

function truncate(text: string, full: boolean): string {
  return full || text.length <= 70 ? text : `${text.slice(0, 67)}...`;
}

function describe(result: RunResult, solution?: PaceSolution): AxiStructuredOutput {
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
    ...(solution
      ? {
          target_s: Number((solution.targetMs / 1000).toFixed(1)),
          natural_s: Number((solution.naturalMs / 1000).toFixed(1)),
          ...(solution.warning ? { warning: solution.warning } : {}),
        }
      : {}),
    ...(result.viewport.device ? { device: result.viewport.device } : {}),
    ...(result.identity ? { as: result.identity.label } : {}),
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
  const viewport = viewportOf(flags["viewport"]);
  const targetMs =
    flags["duration"] !== undefined ? parseDuration(flags["duration"] as string) : null;

  const results: RunResult[] = [];
  const solutions = new Map<string, PaceSolution>();
  for (const { scenario, file } of selected) {
    const sourceText = await readFile(file, "utf8").catch(() => undefined);

    // Everything except the mode and the pace, which the measuring pass and
    // the real take each set for themselves.
    const base = {
      scenario,
      config,
      ...(sourceText ? { sourceText } : {}),
      ...(flags["base-url"] ? { baseUrl: flags["base-url"] as string } : {}),
      ...(flags["out"] ? { outDir: resolve(process.cwd(), flags["out"] as string) } : {}),
      ...(flags["device"] ? { device: flags["device"] as string } : {}),
      ...(orientation ? { orientation } : {}),
      ...(flags["headed"] === true ? { headed: true } : {}),
      ...(flags["keep-raw"] === true ? { keepRaw: true } : {}),
      ...(flags["no-auth"] === true
        ? { auth: false as const }
        : flags["auth"]
          ? { auth: flags["auth"] as string }
          : {}),
      ...(viewport ? { viewport } : {}),
      ...(toolchain ? { toolchain } : {}),
      // stderr: stdout stays reserved for the final payload.
      log: (message: string) => void process.stderr.write(`${message}\n`),
    };

    let pace = flags["pace"] as number | undefined;

    if (targetMs !== null) {
      // Measured, not assumed: a scenario's length is only roughly linear in
      // pace, because the app's own waits do not scale with it. One no-encode
      // pass is the cheapest honest way to learn the natural length.
      process.stderr.write(`${scenario.id}: measuring for a ${targetMs / 1000}s target\n`);
      const probe = await runScenario({ ...base, mode: "rehearse", pace: 1 });
      const solution = solvePace(probe.durationMs, targetMs, probe.scaledPauseMs);
      solutions.set(scenario.id, solution);
      pace = solution.pace;
      if (solution.warning) process.stderr.write(`${scenario.id}: ${solution.warning}\n`);
    }

    results.push(await runScenario({ ...base, mode, ...(pace !== undefined ? { pace } : {}) }));
  }

  if (results.length === 1) {
    const only = results[0] as RunResult;
    const full = flags["full"] === true;
    // A rehearsal is where someone checks what a scenario does before trusting
    // it, so the log is the point of the output rather than an extra.
    const showLog = mode === "rehearse" || full;
    return {
      ...describe(only, solutions.get(only.id)),
      ...(only.hosts.length > 0 ? { hosts: only.hosts } : {}),
      ...(showLog ? { performed: performed(only, full) } : {}),
      help: nextSteps(only, showLog),
    };
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

function nextSteps(result: RunResult, showedLog = false): string[] {
  if (result.mode === "rehearse") {
    return [
      ...(showedLog
        ? [
            "`performed` above is every action the scenario took - read it before trusting a script you did not write",
          ]
        : []),
      `Selectors and narration hold. Run \`screencast-axi record ${result.id}\` for the real take`,
      "A rehearsal runs faster than a take, so it can trip on an animation a recording would wait out",
    ];
  }
  return [
    ...(showedLog ? [] : ["Add `--full` to see every action the scenario took"]),
    `The clip is ${(result.durationMs / 1000).toFixed(1)}s. Re-cut it with \`screencast-axi record ${result.id} --pace 0.8\` (lower is faster)`,
    result.manifestPath
      ? `Title, description and steps are in ${relative(process.cwd(), result.manifestPath)} for a site to read`
      : "",
  ].filter(Boolean);
}

export { ScenarioFailure };
