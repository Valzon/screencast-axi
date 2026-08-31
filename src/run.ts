import { rm } from "node:fs/promises";
import { captureSize, openContext, resolveViewport, type ResolvedViewport } from "./browser.js";
import { selectStrategy, type ResolvedConfig } from "./config.js";
import type { AuthContext, AuthIdentity } from "./auth/types.js";
import { Director, type DirectorAction } from "./director.js";
import { encode, type EncodeResult, type EncodeSettings } from "./encode.js";
import { ScreencastError } from "./errors.js";
import { captureFailure, type Forensics } from "./forensics.js";
import { hashSteps, hashText, upsertEntry, type ManifestEntry } from "./manifest.js";
import { overlayInitScript, resolveOverlayTheme } from "./overlay.js";
import { detectToolchain, missingFfmpegError, type Toolchain } from "./toolchain.js";
import type { DefinedScenario, ScenarioContext, Viewport } from "./types.js";
import { VERSION } from "./version.js";

export type RunMode = "record" | "rehearse";

export interface RunOptions {
  readonly scenario: DefinedScenario;
  readonly config: ResolvedConfig;
  readonly mode: RunMode;
  /** Source of the scenario module, hashed so staleness is answerable later. */
  readonly sourceText?: string;
  readonly baseUrl?: string;
  readonly outDir?: string;
  readonly pace?: number;
  readonly headed?: boolean;
  readonly device?: string;
  readonly viewport?: Viewport;
  readonly orientation?: "portrait" | "landscape";
  readonly keepRaw?: boolean;
  /** Per-run overrides on the encode settings, e.g. the looping formats. */
  readonly deliverables?: Partial<EncodeSettings>;
  /** Named strategy, or false to record signed out. */
  readonly auth?: string | false;
  readonly toolchain?: Toolchain;
  /** Progress, to stderr. stdout stays reserved for the final payload. */
  log?(message: string): void;
}

export interface RunResult {
  readonly id: string;
  readonly mode: RunMode;
  readonly durationMs: number;
  /** Of that, how much was pace-scaled pause rather than the app's own waits. */
  readonly scaledPauseMs: number;
  readonly pace: number;
  readonly viewport: ResolvedViewport;
  readonly steps: readonly string[];
  /** Everything the scenario did, in order. */
  readonly performed: readonly DirectorAction[];
  /** Hosts the take actually visited - the safety-relevant summary. */
  readonly hosts: readonly string[];
  readonly identity?: AuthIdentity;
  /** Present only for a recording. */
  readonly encoded?: EncodeResult;
  readonly manifestPath?: string;
  readonly entry?: ManifestEntry;
}

/**
 * A take failed. Carries what was on screen when it did.
 *
 * The forensics are the point: without them a stale selector is a bare
 * timeout, and fixing it means another forty-second run to see anything.
 */
export class ScenarioFailure extends ScreencastError {
  readonly scenarioId: string;
  readonly phase: "setup" | "run" | "encode";
  readonly forensics: Forensics;
  readonly lastStep: number | null;

  constructor(init: {
    scenarioId: string;
    phase: "setup" | "run" | "encode";
    message: string;
    forensics: Forensics;
    lastStep: number | null;
    suggestions: string[];
  }) {
    super(init.message, "SCENARIO_FAILED", init.suggestions);
    this.name = "ScenarioFailure";
    this.scenarioId = init.scenarioId;
    this.phase = init.phase;
    this.forensics = init.forensics;
    this.lastStep = init.lastStep;
  }
}

/**
 * Every declared narration line must appear once, in order.
 *
 * This is what stops the written workflow drifting from the recorded one: the
 * same array becomes the burnt-in caption, the manifest's step list and the
 * text a site renders beside the clip, so a line that never went on screen
 * would be a caption promising something the video does not show.
 */
export function assertScriptComplete(
  steps: readonly string[] | undefined,
  shown: readonly number[],
): void {
  const declared = steps?.length ?? 0;
  if (declared === 0) return;

  const expected = Array.from({ length: declared }, (_, i) => i);
  const sameLength = shown.length === expected.length;
  const inOrder = sameLength && shown.every((value, index) => value === expected[index]);
  if (inOrder) return;

  const missing = expected.filter((i) => !shown.includes(i));
  throw new ScreencastError(
    `The take showed steps [${shown.join(", ")}] but the scenario declares ${declared}`,
    "SCRIPT_INCOMPLETE",
    [
      missing.length > 0
        ? `Never shown: ${missing.map((i) => `step ${i} ("${steps?.[i] ?? ""}")`).join(", ")}`
        : "Every step ran, but not once each in order",
      "Call `await d.step(i)` once per declared line, in order, inside run()",
    ],
  );
}

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { scenario, config, mode } = options;
  const log = options.log ?? (() => {});
  const recording = mode === "record";

  const outDir = options.outDir ?? config.outDir;
  const baseUrl = options.baseUrl ?? scenario.baseUrl ?? config.baseUrl;
  const pace = options.pace ?? scenario.pace ?? config.pace;

  const viewport = await resolveViewport(
    {
      ...((options.device ?? scenario.device ?? config.device)
        ? { device: options.device ?? scenario.device ?? config.device }
        : {}),
      ...((options.viewport ?? scenario.viewport)
        ? { viewport: options.viewport ?? scenario.viewport }
        : {}),
      ...((options.orientation ?? scenario.orientation)
        ? { orientation: options.orientation ?? scenario.orientation }
        : {}),
      ...(config.browser.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: config.browser.deviceScaleFactor }
        : {}),
    },
    config.viewport,
  );

  // Fail before the browser opens, not forty seconds into a take that cannot
  // possibly produce a file.
  let toolchain = options.toolchain;
  if (recording) {
    toolchain = toolchain ?? (await detectToolchain());
    if (!toolchain.ffmpeg) throw missingFfmpegError();
  }

  const strategy = selectStrategy(config, scenario.auth, options.auth);
  const authCtx: AuthContext = {
    baseUrl,
    rootDir: config.rootDir,
    scenario: { id: scenario.id, title: scenario.title },
    log: (message) => log(`  ${message}`),
  };

  // Before the browser opens, so an unreachable auth server costs a second
  // rather than a take that has already started recording.
  await strategy?.preflight?.(authCtx);
  const patch = strategy?.prepareContext?.(authCtx) ?? {};

  const opened = await openContext({
    resolved: viewport,
    headless: options.headed ? false : config.browser.headless,
    args: config.browser.args,
    ...(config.browser.profileDir ? { profileDir: config.browser.profileDir } : {}),
    ...(recording ? { recordVideoDir: config.rawDir } : {}),
    ...(config.browser.colorScheme ? { colorScheme: config.browser.colorScheme } : {}),
    ...(config.browser.locale ? { locale: config.browser.locale } : {}),
    ...(config.browser.timezoneId ? { timezoneId: config.browser.timezoneId } : {}),
    ...(patch.storageState ? { storageState: patch.storageState } : {}),
    ...(patch.httpCredentials ? { httpCredentials: patch.httpCredentials } : {}),
  });

  await opened.context.addInitScript({
    content: overlayInitScript(resolveOverlayTheme(config.overlay)),
  });

  // A rehearsal exists to fail fast. Playwright's 30s default is right for a
  // take - a real app can genuinely take that long to settle - but it makes a
  // rehearsal cost as much as the recording it was meant to replace, which
  // defeats the point. A take keeps the generous default.
  if (!recording) {
    opened.context.setDefaultTimeout(config.timeouts.rehearseMs);
  }

  const director = new Director(
    opened.page,
    {
      baseUrl,
      pace,
      settleMs: config.timeouts.settleMs,
      ...(scenario.steps ? { steps: scenario.steps } : {}),
    },
    opened.createdAt,
  );

  const ctx: ScenarioContext = {
    baseUrl,
    outDir,
    rawDir: config.rawDir,
    log: (message) => log(`  ${message}`),
  };

  let clipEndedAt = opened.createdAt;
  let rawVideoPath: string | null = null;
  let identity: AuthIdentity | undefined;

  /**
   * Turns a thrown error into a failure that carries the page's state.
   *
   * Gathered here, *before* the context closes. Closing first - which the
   * original in-repo recorder had to do, since the capture is only finalised
   * on close - threw the page away along with any chance of seeing why the
   * take failed.
   */
  const fail = async (phase: "setup" | "run", error: unknown): Promise<never> => {
    const forensics = await captureFailure({
      page: opened.page,
      rawDir: config.rawDir,
      id: scenario.id,
      error,
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new ScenarioFailure({
      scenarioId: scenario.id,
      phase,
      message: `${scenario.id}: ${message}`,
      forensics,
      lastStep: director.shownSteps.at(-1) ?? null,
      suggestions: buildSuggestions(scenario.id, forensics, mode),
    });
  };

  try {
    log(`${scenario.id}: ${baseUrl} at ${viewport.viewport.width}x${viewport.viewport.height}`);

    try {
      if (strategy) {
        identity = (await strategy.signIn?.(opened.page, authCtx)) ?? identity;
        await strategy.assertSignedIn?.(opened.page, authCtx);
        log(`  signed in via ${strategy.name}${identity ? ` as ${identity.label}` : ""}`);
      }
      await scenario.setup?.(opened.page, ctx);
    } catch (error) {
      await fail("setup", error);
    }

    director.markClipStart();

    try {
      await scenario.run(director, ctx);
      assertScriptComplete(scenario.steps, director.shownSteps);
      await director.caption(null);
      await director.beat(600);
    } catch (error) {
      await fail("run", error);
    }

    clipEndedAt = Date.now();
  } finally {
    await scenario.teardown?.(opened.page, ctx).catch(() => undefined);
    const video = recording ? opened.page.video() : null;
    // The capture is only written out when the context closes, so read the
    // path afterwards rather than before.
    await opened.close();
    if (video) rawVideoPath = await video.path().catch(() => null);
  }

  const trimStart = director.trimStartSeconds;
  const durationMs = Math.max(0, clipEndedAt - opened.createdAt - Math.round(trimStart * 1000));

  if (!recording) {
    return {
      id: scenario.id,
      mode,
      durationMs,
      scaledPauseMs: director.scaledPauseMs,
      pace,
      viewport,
      steps: scenario.steps ?? [],
      performed: director.performed,
      hosts: hostsVisited(director.performed),
      ...(identity ? { identity } : {}),
    };
  }

  if (!rawVideoPath) {
    throw new ScreencastError("Playwright produced no video for this take", "NO_CAPTURE", [
      "The context closed without writing a capture - check the raw directory is writable",
      `Raw directory: ${config.rawDir}`,
    ]);
  }

  // Never scale beyond what was captured: upscaling a 390px phone capture to
  // a 1280px deliverable multiplies the file size without adding a pixel of
  // detail. Height follows the source aspect rather than being measured, so a
  // consumer can size the player before the video decodes.
  const capture = captureSize(viewport);
  const width = Math.min(config.deliverables.width, capture.width);
  const height = Math.round(((width / capture.width) * capture.height) / 2) * 2;

  const encoded = await encode({
    ...config.deliverables,
    ...options.deliverables,
    width,
    input: rawVideoPath,
    outDir,
    id: scenario.id,
    trimStart,
    ...(toolchain ? { toolchain } : {}),
  });

  if (!options.keepRaw) await rm(rawVideoPath, { force: true });

  const formats = Object.keys(encoded.sizes).map((f) => f.split(".").pop() ?? "");

  const entry: ManifestEntry = {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    ...(scenario.steps ? { steps: scenario.steps } : {}),
    width,
    height,
    durationMs,
    recordedAt: new Date().toISOString(),
    pace,
    ...(viewport.device ? { device: viewport.device } : {}),
    formats,
    ...(options.sourceText ? { sourceHash: hashText(options.sourceText) } : {}),
    stepsHash: hashSteps(scenario.steps),
    recorderVersion: VERSION,
  };

  const manifestPath = upsertEntry(outDir, entry);
  log(`${scenario.id}: ${Object.keys(encoded.sizes).join(", ")}`);

  return {
    id: scenario.id,
    mode,
    durationMs,
    scaledPauseMs: director.scaledPauseMs,
    pace,
    viewport,
    steps: scenario.steps ?? [],
    performed: director.performed,
    hosts: hostsVisited(director.performed),
    ...(identity ? { identity } : {}),
    encoded,
    manifestPath,
    entry,
  };
}

function buildSuggestions(id: string, forensics: Forensics, mode: RunMode): string[] {
  const out: string[] = [];
  if (forensics.screenshot) {
    out.push(`Open ${forensics.screenshot} to see what was on screen when it failed`);
  }
  const dead = forensics.nearMatches?.find((m) => m.count === 0);
  const alive = forensics.nearMatches?.find((m) => m.count > 0);
  if (dead && alive) {
    out.push(
      `\`${alive.selector}\` matched ${alive.count} but \`${dead.selector}\` matched none - ` +
        `the container rendered and its contents did not, which is usually data, not the selector`,
    );
  }
  out.push(
    "To find the right selector, drive the page live with a browser tool " +
      "(for example `npx -y chrome-devtools-axi navigate <url>` then `snapshot`)",
  );
  if (mode === "record") {
    out.push(`Re-check a fix in seconds with \`screencast-axi rehearse ${id}\``);
  }
  return out;
}

/**
 * The hosts a take actually reached.
 *
 * The short answer to "where did this thing go". A scenario is arbitrary code
 * driving a signed-in browser, and a list of two hosts is a very different
 * thing to read than a list of nine.
 */
function hostsVisited(actions: readonly DirectorAction[]): string[] {
  const hosts: string[] = [];
  for (const action of actions) {
    if (action.kind !== "goto" || !action.target) continue;
    try {
      const url = new URL(action.target);
      // A file:// URL has no host, and a blank entry answers nothing. Name the
      // scheme instead, which is the fact that matters: it stayed local.
      const host = url.host || `${url.protocol}//`;
      if (!hosts.includes(host)) hosts.push(host);
    } catch {
      // Not an absolute URL; the goto resolved it against baseUrl already.
    }
  }
  return hosts;
}
