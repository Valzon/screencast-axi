import type { Locator, Page } from "playwright";
import type { Director } from "./director.js";

/** Anything a Director action can aim at. */
export type Target = string | Locator | { x: number; y: number };

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface ScenarioContext {
  /** Base URL the scenario navigates against, e.g. http://localhost:4000 */
  readonly baseUrl: string;
  /** Directory the deliverables are written to. */
  readonly outDir: string;
  /** Scratch directory for raw captures, logs and failure artifacts. */
  readonly rawDir: string;
  /** Whoever the auth strategy signed in as, when one ran. */
  readonly identity?: { readonly id: string; readonly label: string };
  /** Progress line. Goes to stderr and the run log, never to stdout. */
  log(message: string): void;
}

export interface Scenario {
  /** Output file stem: `task-create` -> task-create.mp4 / .webm / .webp */
  readonly id: string;
  /** Human title. Shown in the CLI and written to the manifest. */
  readonly title: string;
  /** One line describing what the clip demonstrates. Written to the manifest. */
  readonly description: string;
  /** Default base URL, overridable with --base-url. */
  readonly baseUrl?: string;
  /** Recording viewport, or a Playwright device preset name. */
  readonly viewport?: Viewport;
  readonly device?: string;
  readonly orientation?: "portrait" | "landscape";
  /** Playback speed multiplier. Lower is faster. */
  readonly pace?: number;
  /** Ask the recorder to solve for `pace` so the clip lands near this length. */
  readonly targetDurationMs?: number;
  /**
   * The clip's narration, in the order it appears on screen. `run()` puts each
   * line up with `director.step(i)` rather than typing it inline, so this array
   * is simultaneously the burnt-in captions and the plain text of the workflow:
   * the recorder writes it to the manifest, and a site can render it beside the
   * clip so the workflow is readable without watching.
   *
   * A take that does not show every line, in order, exactly once is rejected,
   * so the written workflow cannot quietly stop matching the recorded one.
   */
  readonly steps?: readonly string[];
  /** Named auth strategy, or false for a signed-out recording. */
  readonly auth?: string | false;
  /** Free-form labels for filtering in `list`. */
  readonly tags?: readonly string[];
  /** Runs before the clip starts: navigation, data setup, state reset. */
  setup?(page: Page, ctx: ScenarioContext): Promise<void>;
  /** The clip itself. Everything here is recorded. */
  run(director: Director, ctx: ScenarioContext): Promise<void>;
  /** Runs after the take, successful or not. */
  teardown?(page: Page, ctx: ScenarioContext): Promise<void>;
}

/** Marks an object as a scenario, so discovery can find it in any export. */
export const SCENARIO_MARKER = Symbol.for("screencast-axi.scenario");

export type DefinedScenario = Scenario & { readonly [SCENARIO_MARKER]: true };

/**
 * Identity function that stamps a scenario so discovery can recognise it.
 *
 * A module may export it as `default`, as a named export, or as one of
 * several - the stamp is what makes it findable, rather than a naming
 * convention the author has to remember.
 */
export function defineScenario(scenario: Scenario): DefinedScenario {
  return { ...scenario, [SCENARIO_MARKER]: true };
}

export function isScenario(value: unknown): value is DefinedScenario {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[SCENARIO_MARKER] === true
  );
}
