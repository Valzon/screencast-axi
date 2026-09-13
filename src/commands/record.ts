import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig, loadScenarioFiles, loadScenarios, type ResolvedConfig } from "../config.js";
import { ScreencastError } from "../errors.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import type { AxiStructuredOutput } from "../output.js";
import {
  baseUrlFor,
  runScenario,
  ScenarioFailure,
  viewportFor,
  type RunMode,
  type RunOptions,
  type RunResult,
} from "../run.js";
import type { ResolvedViewport } from "../browser.js";
import { readMeasurement, type MeasurementKey } from "../measure.js";
import { readManifest, type ManifestEntry } from "../manifest.js";
import { buildInventory } from "../inventory.js";
import { closest } from "../nearest.js";
import { parseTarget, solvePace, type PaceSolution } from "../duration.js";
import { detectToolchain } from "../toolchain.js";
import type { DefinedScenario } from "../types.js";

const SHARED: FlagSpecs = {
  config: { kind: "string", description: "Path to a config file", placeholder: "path" },
  "base-url": {
    kind: "string",
    description: "Override the scenario's base URL",
    placeholder: "url",
  },
  pace: {
    kind: "number",
    description: "Speed multiplier; lower is faster",
    example: 0.8,
    // Wider than the range `--duration` solves within, because an explicit
    // pace is a deliberate choice - but still a multiplier, not a duration.
    min: 0.1,
    max: 5,
  },
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
  "if-changed": {
    kind: "boolean",
    description: "Skip clips already recorded from the current scenario",
  },
  full: { kind: "boolean", description: "Include the full action log" },
  gif: { kind: "boolean", description: "Also emit a looping GIF" },
  webp: { kind: "boolean", description: "Also emit a looping WebP (half a GIF's size)" },
  "loop-width": {
    kind: "number",
    description: "Width of the looping formats",
    example: 800,
    min: 16,
  },
  "loop-fps": {
    kind: "number",
    description: "Frame rate of the looping formats",
    example: 15,
    min: 1,
    max: 60,
  },
  "keep-raw": { kind: "boolean", description: "Keep the raw capture for inspection" },
};

export const REHEARSE_FLAGS: FlagSpecs = SHARED;

interface Selected {
  readonly scenario: DefinedScenario;
  readonly file: string;
}

/**
 * A scenario the manifest remembers recording, by id.
 *
 * A clip recorded by path is not in the config, so re-cutting it by id - the
 * command `record` itself prints when it finishes - used to fail with
 * `UNKNOWN_SCENARIO`. The manifest knows which file the clip came from, so
 * the id is answerable without the config listing it.
 */
async function recordedAs(id: string, config: ResolvedConfig): Promise<Selected | null> {
  const entry = readManifest(config.outDir).entries.find((e) => e.id === id);
  if (!entry?.sourceFile) return null;
  const file = isAbsolute(entry.sourceFile)
    ? entry.sourceFile
    : resolve(config.outDir, entry.sourceFile);
  if (!existsSync(file)) return null;
  const loaded = await loadScenarioFiles([file]).catch(() => []);
  return loaded.find((l) => l.scenario.id === id) ?? null;
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
    const match = loaded.find((l) => l.scenario.id === id) ?? (await recordedAs(id, config));
    if (!match) {
      const known = loaded.map((l) => l.scenario.id);
      const meant = closest(id, known);
      throw new ScreencastError(`Unknown scenario: ${id}`, "UNKNOWN_SCENARIO", [
        ...(meant ? [`Did you mean \`${meant}\`?`] : []),
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

/**
 * What a stored measurement has to match to describe this take.
 *
 * Null when the scenario's source could not be read: without it an edit
 * cannot be detected, and a measurement that might describe an older version
 * of the scenario is not one worth keeping.
 */
async function measurementKey(
  options: RunOptions,
  sourceText: string | undefined,
): Promise<MeasurementKey | null> {
  if (sourceText === undefined) return null;
  const viewport = await viewportFor(options);
  return {
    scenarioId: options.scenario.id,
    sourceText,
    steps: options.scenario.steps,
    baseUrl: baseUrlFor(options),
    width: viewport.viewport.width,
    height: viewport.viewport.height,
    ...(viewport.device ? { device: viewport.device } : {}),
  };
}

/**
 * Narrows a selection to the clips that actually need re-shooting.
 *
 * The companion of `check`, which is where someone learns that three of
 * fifteen clips have drifted. Without it the only way to act on that is
 * `record --all`, which re-shoots the twelve that were fine - minutes of
 * browser time and twelve identical files rewritten.
 *
 * "Changed" is the inventory's own judgement, so this and `check` cannot
 * disagree: anything not `recorded` (stale narration, an edited scenario, a
 * missing deliverable, never recorded at all) is in.
 */
async function onlyChanged(
  selected: readonly Selected[],
  config: ResolvedConfig,
  flags: Record<string, unknown>,
  presentation: (scenario: DefinedScenario) => Promise<ResolvedViewport>,
): Promise<Selected[]> {
  if (flags["if-changed"] !== true) return [...selected];

  const inventory = await buildInventory(config);
  const needsWork = new Set(
    inventory.rows.filter((row) => row.status !== "recorded").map((row) => row.id),
  );
  const byId = new Map(inventory.rows.map((row) => [row.id, row.entry]));

  const keep: Selected[] = [];
  for (const item of selected) {
    if (needsWork.has(item.scenario.id)) {
      keep.push(item);
      continue;
    }
    // How it would be shot this time. A clip recorded at another size, or
    // under another device preset, is a different clip - and comparing only
    // the scenario's text meant `--device` on the command line was answered
    // with "nothing has changed" and a stale file at the old size.
    const entry = byId.get(item.scenario.id);
    const wanted = await presentation(item.scenario);
    if (entry && !sameFraming(entry, wanted)) keep.push(item);
  }
  return keep;
}

/** Whether a recorded clip was shot the way this run would shoot it. */
function sameFraming(entry: ManifestEntry, wanted: ResolvedViewport): boolean {
  // An entry from before viewports were recorded cannot be compared, and
  // re-shooting everything once is a worse answer than trusting it.
  if (!entry.viewport) return (entry.device ?? null) === (wanted.device ?? null);
  return (
    entry.viewport.width === wanted.viewport.width &&
    entry.viewport.height === wanted.viewport.height &&
    (entry.device ?? null) === (wanted.device ?? null)
  );
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

function describe(
  result: RunResult,
  solution?: PaceSolution,
  reusedMeasurement = false,
): AxiStructuredOutput {
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
    // The size the page was laid out at, and - separately - the size of the
    // file. They are not always the same: the capture is capped and the
    // deliverable is scaled to `deliverables.width`, so printing only the
    // first told people their clip was a size it had never been.
    viewport: `${result.viewport.viewport.width}x${result.viewport.viewport.height}`,
    ...(result.entry ? { output: `${result.entry.width}x${result.entry.height}` } : {}),
    ...(solution
      ? {
          target_s: Number((solution.targetMs / 1000).toFixed(1)),
          natural_s: Number((solution.naturalMs / 1000).toFixed(1)),
          // Which of the two browser passes this take actually cost.
          measured: reusedMeasurement ? "reused from an earlier pass" : "this run",
          ...(solution.warning ? { warning: solution.warning } : {}),
        }
      : {}),
    ...(result.viewport.device ? { device: result.viewport.device } : {}),
    ...(result.viewport.viewportOverridden
      ? {
          note:
            `the ${result.viewport.device} preset supplied the user agent and touch flags, ` +
            `but the page was laid out at the viewport you gave, not the preset's`,
        }
      : {}),
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
  // Declared before `selected`, because the framing comparison below reads
  // them while deciding what to skip.
  const orientation = orientationOf(flags["orientation"]);
  const viewport = viewportOf(flags["viewport"]);

  const selected = await onlyChanged(
    await select(positionals, config, all),
    config,
    flags,
    (scenario) =>
      viewportFor({
        scenario,
        config,
        mode,
        ...(flags["device"] ? { device: flags["device"] as string } : {}),
        ...(orientation ? { orientation } : {}),
        ...(viewport ? { viewport } : {}),
      }),
  );

  if (selected.length === 0) {
    return flags["if-changed"] === true
      ? {
          [mode]: [],
          totals: "nothing has changed",
          help: ["Every configured clip is recorded from its current scenario"],
        }
      : { [mode]: [], totals: "0 scenarios matched", help: ["Run `screencast-axi list`"] };
  }

  // Probed once for the batch rather than per clip, and before any browser
  // opens - a missing ffmpeg should not cost a forty-second take first.
  const toolchain = mode === "record" ? await detectToolchain() : undefined;

  // Both given is a contradiction, not a precedence question: `--pace` states
  // the pace and `--duration` asks for one to be solved. Silently dropping
  // either would produce a clip that is not the length the flag asked for.
  if (flags["duration"] !== undefined && flags["pace"] !== undefined) {
    throw new ScreencastError(
      "`--duration` and `--pace` cannot both be given",
      "VALIDATION_ERROR",
      [
        "`--duration 30s` solves for the pace that lands near that length",
        "`--pace 0.8` sets it directly, leaving nothing to solve for",
      ],
    );
  }

  const flagTargetMs =
    flags["duration"] !== undefined ? parseTarget(flags["duration"] as string) : null;

  // Looping formats are for the places a <video> does not render. They are far
  // heavier than the mp4, so they stay opt-in per run.
  const loops =
    flags["gif"] === true ||
    flags["webp"] === true ||
    flags["loop-width"] !== undefined ||
    flags["loop-fps"] !== undefined
      ? {
          ...(flags["gif"] === true ? { gif: true } : {}),
          ...(flags["webp"] === true ? { animatedWebp: true } : {}),
          ...(flags["loop-width"] !== undefined ? { gifWidth: flags["loop-width"] as number } : {}),
          ...(flags["loop-fps"] !== undefined ? { gifFps: flags["loop-fps"] as number } : {}),
        }
      : null;

  const results: RunResult[] = [];
  const solutions = new Map<string, PaceSolution>();
  /** Scenarios whose natural length came from a previous pass rather than a new one. */
  const reused = new Set<string>();
  for (const { scenario, file } of selected) {
    const sourceText = await readFile(file, "utf8").catch(() => undefined);

    // Everything except the mode and the pace, which the measuring pass and
    // the real take each set for themselves.
    const base = {
      scenario,
      config,
      ...(sourceText ? { sourceText } : {}),
      sourceFile: file,
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
      ...(loops ? { deliverables: loops } : {}),
      ...(toolchain ? { toolchain } : {}),
      // stderr: stdout stays reserved for the final payload.
      log: (message: string) => void process.stderr.write(`${message}\n`),
    };

    let pace = flags["pace"] as number | undefined;

    // The flag wins over the scenario's own target, so a re-cut at another
    // length needs no edit. An explicit --pace wins over both: it says what
    // the pace is, leaving nothing to solve for.
    const targetMs =
      pace !== undefined ? null : (flagTargetMs ?? scenario.targetDurationMs ?? null);

    if (targetMs !== null) {
      // Measured, not assumed: a scenario's length is only roughly linear in
      // pace, because the app's own waits do not scale with it. One no-encode
      // pass is the cheapest honest way to learn the natural length - and a
      // rehearsal already ran one, so the answer is often already known.
      const key = await measurementKey({ ...base, mode: "rehearse", pace: 1 }, sourceText);
      const cached = key ? readMeasurement(config.rawDir, key) : null;

      let natural: { durationMs: number; scaledPauseMs: number };
      if (cached) {
        process.stderr.write(
          `${scenario.id}: reusing the measured ${(cached.durationMs / 1000).toFixed(1)}s ` +
            `for a ${targetMs / 1000}s target\n`,
        );
        natural = cached;
        reused.add(scenario.id);
      } else {
        process.stderr.write(`${scenario.id}: measuring for a ${targetMs / 1000}s target\n`);
        natural = await runScenario({ ...base, mode: "rehearse", pace: 1 });
      }

      const solution = solvePace(natural.durationMs, targetMs, natural.scaledPauseMs);
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
      ...describe(only, solutions.get(only.id), reused.has(only.id)),
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
