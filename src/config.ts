import { ScreencastError } from "./errors.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_ENCODE_SETTINGS, type EncodeSettings } from "./encode.js";
import { DEFAULT_SETTLE_MS } from "./director.js";
import { DEFAULT_OVERLAY_THEME, type DeepPartial, type OverlayTheme } from "./overlay.js";
import {
  defineScenario,
  isScenario,
  looksLikeScenario,
  type DefinedScenario,
  type Viewport,
} from "./types.js";
import { importFromProject } from "./resolve.js";
import { noAuth } from "./auth/strategies.js";
import type { AuthConfig, AuthStrategy } from "./auth/types.js";

/**
 * Configuration, and finding the scenarios.
 *
 * A config file is the scale-up path, not the entry fee: `record ./clip.ts`
 * works with no config at all, on defaults rooted at the current directory.
 * Someone recording one page of a site they do not own should not have to
 * learn a config format first.
 */

export interface BrowserConfig {
  readonly headless: boolean;
  /**
   * Persistent Chrome profile directory.
   *
   * Present means a warm profile, so a session a human signed into by hand
   * survives between takes. Absent means an isolated context per take.
   */
  readonly profileDir?: string;
  /** Overrides a device preset's own scale factor. Rarely wanted. */
  readonly deviceScaleFactor?: number;
  readonly args: readonly string[];
  readonly colorScheme?: "light" | "dark";
  readonly locale?: string;
  readonly timezoneId?: string;
}

export interface ScreencastConfig {
  readonly outDir?: string;
  readonly rawDir?: string;
  /** File paths, directories, or `dir/*.ts` patterns. */
  readonly scenarios?: readonly string[];
  readonly baseUrl?: string;
  readonly viewport?: Viewport;
  readonly device?: string;
  readonly pace?: number;
  readonly deliverables?: Partial<EncodeSettings>;
  readonly browser?: Partial<BrowserConfig>;
  readonly overlay?: DeepPartial<OverlayTheme>;
  /** One strategy, or several by name for `--auth <name>`. */
  readonly auth?: AuthConfig;
  readonly timeouts?: {
    readonly setupMs?: number;
    readonly runMs?: number;
    /** Per-action timeout during a rehearsal. Deliberately short. */
    readonly rehearseMs?: number;
    /**
     * Per-action timeout during a take.
     *
     * Longer than a rehearsal's, because a take waits on a real app rather
     * than trying to fail fast - but bounded and stated, rather than left to
     * Playwright's 30s default, so a wrong selector is 15 seconds of waiting
     * instead of thirty. Raise it for an app that genuinely needs longer.
     */
    readonly actionMs?: number;
    /** Ceiling on how long `goto` waits for the network to go quiet. */
    readonly settleMs?: number;
  };
}

export interface ResolvedConfig {
  /** Directory every relative path in the config resolves against. */
  readonly rootDir: string;
  /** Absolute path of the config file, or null when running without one. */
  readonly configPath: string | null;
  readonly outDir: string;
  readonly rawDir: string;
  readonly scenarios: readonly string[];
  readonly baseUrl: string;
  readonly viewport: Viewport;
  readonly device?: string;
  readonly pace: number;
  readonly deliverables: EncodeSettings;
  readonly browser: BrowserConfig;
  readonly overlay: DeepPartial<OverlayTheme>;
  readonly auth: Readonly<Record<string, AuthStrategy>>;
  readonly timeouts: {
    readonly setupMs: number;
    readonly runMs: number;
    readonly rehearseMs: number;
    readonly actionMs: number;
    readonly settleMs: number;
  };
}

export const CONFIG_BASENAMES = [
  "screencast.config.ts",
  "screencast.config.mts",
  "screencast.config.js",
  "screencast.config.mjs",
] as const;

const DEFAULT_VIEWPORT: Viewport = { width: 1600, height: 1000 };

/**
 * Chromium flags that make a capture look deliberate rather than incidental:
 * no scrollbars in frame, sRGB so colours match the design, and no font
 * hinting so text renders the same on every machine that reshoots.
 */
export const DEFAULT_BROWSER_ARGS = [
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
] as const;

/** Identity function, for the types and the editor completion. */
export function defineConfig(config: ScreencastConfig): ScreencastConfig {
  return config;
}

/** Walks up from `startDir` looking for a config file. */
export function findConfigPath(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_BASENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveConfigPath(explicit?: string, cwd = process.cwd()): string | null {
  const chosen = explicit ?? process.env["SCREENCAST_CONFIG"];
  if (chosen) {
    const absolute = isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
    if (!existsSync(absolute)) {
      throw new ScreencastError(`Config not found: ${absolute}`, "CONFIG_NOT_FOUND", [
        "Pass `--config <path>` pointing at an existing file",
        "Or drop the flag to search upwards from the current directory",
      ]);
    }
    return absolute;
  }
  return findConfigPath(cwd);
}

/**
 * Imports a module, registering `tsx` first if Node cannot load TypeScript.
 *
 * The package does not own transpilation. Node's own type stripping does not
 * resolve tsconfig path aliases, which real scenarios use to reach a project's
 * own code, so `tsx` is the documented way and an optional peer.
 */
let tsxRegistered = false;

/**
 * Loads `tsx/esm/api` from the *project*, not from wherever this package sits.
 *
 * See `importFromProject` for why the working directory has to come first.
 */
async function registerTsx(): Promise<boolean> {
  if (tsxRegistered) return true;

  const tsx = await importFromProject<{ register?: () => void }>(
    "tsx/esm/api",
    (module) => typeof module.register === "function",
  );
  if (!tsx?.register) return false;

  tsx.register();
  tsxRegistered = true;
  return true;
}

/**
 * Flattens CommonJS interop wrapping.
 *
 * A project without `"type": "module"` has its TypeScript compiled to CJS, and
 * `import()` then hands back `{ default: { default: <the export> } }`. Looking
 * only at the top level finds nothing, and the error - "no scenario exported"
 * - points at a file that plainly exports one.
 */
function unwrapModule(module: Record<string, unknown>): Record<string, unknown> {
  const flattened: Record<string, unknown> = { ...module };
  for (const key of ["default", "module.exports"]) {
    const value = module[key];
    if (value && typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        // Inner names win only where the outer level has nothing already.
        if (!(inner in flattened)) flattened[inner] = innerValue;
        else if (inner === "default") flattened[`${key}.${inner}`] = innerValue;
      }
    }
  }
  return flattened;
}

/** This package's own name, as a scenario or config file imports it. */
const SELF = "screencast-axi";

/**
 * Rewrites "cannot find screencast-axi" into something worth reading.
 *
 * A scaffolded scenario opens with `import { defineScenario } from
 * "screencast-axi"`, and that specifier resolves from the *file's* project.
 * Run the CLI through `npx` and this package sits in a cache directory
 * instead, so the import fails on a machine where the command plainly works.
 * Node's own message names a module the author never typed a path for, which
 * reads like a broken install rather than a missing dependency.
 */
function selfImportFailure(file: string, error: unknown): ScreencastError | null {
  const code = (error as { code?: string }).code;
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") return null;

  const message = error instanceof Error ? error.message : String(error);
  if (!new RegExp(`'${SELF}(/[^']*)?'|"${SELF}(/[^"]*)?"`).test(message)) return null;

  return new ScreencastError(
    `Cannot load ${file}: it imports \`${SELF}\`, which this project does not have`,
    "SELF_NOT_INSTALLED",
    [
      `Import only types, so nothing is resolved at runtime: \`import type { Scenario } from "${SELF}"\` and \`export default { ... } satisfies Scenario\``,
      `Or install it beside the file that imports it: \`pnpm add -D ${SELF}\``,
      "Running the CLI through `npx` leaves the package in a cache a runtime import cannot reach",
    ],
  );
}

async function importModule(file: string): Promise<Record<string, unknown>> {
  // Checked before the import, because Node's own message for a missing file
  // names it as a module "imported from" somewhere inside this package - which
  // reads like a broken install rather than the typo it almost always is.
  if (!existsSync(file)) {
    throw new ScreencastError(`No such file: ${file}`, "SCENARIO_NOT_FOUND", [
      "Check the path - it is resolved from the working directory",
      "`screencast-axi list` shows every scenario the config knows about",
      "`screencast-axi scaffold <id> --url <url>` writes a new one",
    ]);
  }

  const url = pathToFileURL(file).href;
  try {
    return unwrapModule((await import(url)) as Record<string, unknown>);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const needsLoader =
      code === "ERR_UNKNOWN_FILE_EXTENSION" ||
      (error instanceof SyntaxError && /\.m?ts$/.test(file));
    if (!needsLoader || tsxRegistered) throw selfImportFailure(file, error) ?? error;

    if (!(await registerTsx())) {
      throw new ScreencastError(
        `Cannot load ${file}: this Node cannot run TypeScript directly`,
        "TS_LOADER_MISSING",
        [
          "Install the loader in this project: `pnpm add -D tsx`",
          "Or write the file as .mjs instead of .ts",
        ],
      );
    }
    try {
      // Cache-bust so the retry does not get the failed module record back.
      return unwrapModule((await import(`${url}?tsx=1`)) as Record<string, unknown>);
    } catch (retried) {
      throw selfImportFailure(file, retried) ?? retried;
    }
  }
}

export async function loadConfig(explicit?: string, cwd = process.cwd()): Promise<ResolvedConfig> {
  const configPath = resolveConfigPath(explicit, cwd);
  const raw: ScreencastConfig = configPath
    ? (((await importModule(configPath))["default"] as ScreencastConfig) ?? {})
    : {};
  return resolveConfig(raw, configPath, cwd);
}

export function resolveConfig(
  raw: ScreencastConfig,
  configPath: string | null,
  cwd = process.cwd(),
): ResolvedConfig {
  // Relative paths anchor to the config file, never to the shell's cwd -
  // otherwise the same command means different things from different
  // directories in the same repo.
  const rootDir = configPath ? dirname(configPath) : resolve(cwd);
  const at = (p: string) => (isAbsolute(p) ? p : resolve(rootDir, p));

  const browser: BrowserConfig = {
    headless: raw.browser?.headless ?? true,
    ...(raw.browser?.profileDir ? { profileDir: at(raw.browser.profileDir) } : {}),
    // No default: a device preset carries its own (2-3 on phones), and a
    // config-level default of 1 would silently override it and throw away the
    // detail that makes a phone clip readable.
    ...(raw.browser?.deviceScaleFactor !== undefined
      ? { deviceScaleFactor: raw.browser.deviceScaleFactor }
      : {}),
    args: raw.browser?.args ?? DEFAULT_BROWSER_ARGS,
    ...(raw.browser?.colorScheme ? { colorScheme: raw.browser.colorScheme } : {}),
    ...(raw.browser?.locale ? { locale: raw.browser.locale } : {}),
    ...(raw.browser?.timezoneId ? { timezoneId: raw.browser.timezoneId } : {}),
  };

  return {
    rootDir,
    configPath,
    outDir: at(raw.outDir ?? "screencasts"),
    rawDir: at(raw.rawDir ?? ".screencast/raw"),
    scenarios: raw.scenarios ?? [],
    baseUrl: raw.baseUrl ?? "http://localhost:3000",
    viewport: raw.viewport ?? DEFAULT_VIEWPORT,
    ...(raw.device ? { device: raw.device } : {}),
    pace: raw.pace ?? 1,
    deliverables: { ...DEFAULT_ENCODE_SETTINGS, ...raw.deliverables },
    browser,
    overlay: { ...DEFAULT_OVERLAY_THEME, ...raw.overlay },
    auth: normaliseAuth(raw.auth),
    timeouts: {
      setupMs: raw.timeouts?.setupMs ?? 120_000,
      runMs: raw.timeouts?.runMs ?? 300_000,
      rehearseMs: raw.timeouts?.rehearseMs ?? 8_000,
      actionMs: raw.timeouts?.actionMs ?? 15_000,
      settleMs: raw.timeouts?.settleMs ?? DEFAULT_SETTLE_MS,
    },
  };
}

const SCENARIO_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];

function isScenarioFile(file: string): boolean {
  return SCENARIO_EXTENSIONS.some((ext) => file.endsWith(ext)) && !file.endsWith(".d.ts");
}

function walk(dir: string, recursive: boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (recursive) found.push(...walk(full, true));
    } else if (isScenarioFile(name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Expands one `scenarios` entry to concrete files.
 *
 * Supports a file path, a directory, `dir/*.ts` and `dir/**` - which is the
 * whole realistic range. A full glob library would be a dependency bought for
 * patterns nobody writes here.
 */
export function expandScenarioPattern(pattern: string, rootDir: string): string[] {
  const absolute = isAbsolute(pattern) ? pattern : join(rootDir, pattern);

  if (!absolute.includes("*")) {
    if (!existsSync(absolute)) return [];
    return statSync(absolute).isDirectory() ? walk(absolute, false) : [absolute];
  }

  const star = absolute.indexOf("*");
  const base = absolute.slice(0, star);
  const dir = base.endsWith(sep) ? base.slice(0, -1) : dirname(base);
  if (!existsSync(dir)) return [];

  const recursive = absolute.includes("**");
  const suffix = absolute.slice(absolute.lastIndexOf("*") + 1);
  return walk(dir, recursive).filter((f) => (suffix ? f.endsWith(suffix) : true));
}

export interface LoadedScenario {
  readonly scenario: DefinedScenario;
  /** Absolute path of the module it came from, for error messages. */
  readonly file: string;
}

/**
 * Loads every scenario the config points at, in declaration order.
 *
 * A module may export its scenario as `default`, as a named export, or several
 * at once: the `defineScenario` stamp is what makes it findable, so nobody has
 * to remember a naming convention.
 */
export async function loadScenarios(config: ResolvedConfig): Promise<LoadedScenario[]> {
  const files: string[] = [];
  for (const pattern of config.scenarios) {
    for (const file of expandScenarioPattern(pattern, config.rootDir)) {
      if (!files.includes(file)) files.push(file);
    }
  }
  return loadScenarioFiles(files);
}

export async function loadScenarioFiles(files: readonly string[]): Promise<LoadedScenario[]> {
  const loaded: LoadedScenario[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const module = await importModule(file);

    // A stamped scenario is found in any export position. An unstamped one is
    // accepted only as the default export - after CJS interop that may sit at
    // `default.default` - so a file needs no runtime import of this package.
    const defaults = [
      module["default"],
      module["default.default"],
      module["module.exports.default"],
    ];
    const candidates: DefinedScenario[] = [
      ...Object.values(module).filter(isScenario),
      ...defaults
        .filter((v) => !isScenario(v) && looksLikeScenario(v))
        .map((v) => v as DefinedScenario),
    ];

    // Deduped by identity: CJS interop exposes the same object under both
    // `default` and `module.exports`, and one scenario seen twice is not two
    // scenarios sharing an id.
    const found = [...new Set(candidates)].map((s) => (isScenario(s) ? s : defineScenario(s)));

    if (found.length === 0) {
      throw new ScreencastError(`No scenario exported by ${file}`, "NO_SCENARIO", [
        "Make it the default export: `export default { id, title, description, run } satisfies Scenario`",
        'Type it with `import type { Scenario } from "screencast-axi"`, which leaves no runtime import',
        "Or wrap a named export: `export const clip = defineScenario({ ... })`",
      ]);
    }

    for (const scenario of found) {
      const previous = seen.get(scenario.id);
      if (previous) {
        // Two clips writing the same file stem would silently overwrite each
        // other, and whichever ran last would win.
        throw new ScreencastError(
          `Duplicate scenario id \`${scenario.id}\``,
          "DUPLICATE_SCENARIO",
          [
            `Defined in ${relative(process.cwd(), previous)} and ${relative(process.cwd(), file)}`,
            "Ids are the output file stem, so they have to be unique",
          ],
        );
      }
      seen.set(scenario.id, file);
      loaded.push({ scenario, file });
    }
  }

  return loaded;
}

/**
 * Normalises the config's `auth` into a name -> strategy map.
 *
 * A single strategy becomes `{ default: it }`, so a scenario saying
 * `auth: true` or nothing at all resolves without the config author having to
 * name anything.
 */
export function normaliseAuth(auth: AuthConfig | undefined): Record<string, AuthStrategy> {
  if (!auth) return { none: noAuth() };
  if (typeof (auth as AuthStrategy).name === "string") {
    return { default: auth as AuthStrategy };
  }
  return auth as Record<string, AuthStrategy>;
}

/**
 * Picks the strategy for a take.
 *
 * `false` on a scenario, or `--no-auth`, means signed out - a deliberate
 * choice worth being able to make per scenario, since a landing page and a
 * dashboard often live in the same config.
 */
export function selectStrategy(
  config: ResolvedConfig,
  scenarioAuth: string | false | undefined,
  override?: string | false,
): AuthStrategy | null {
  const chosen = override !== undefined ? override : scenarioAuth;
  if (chosen === false) return null;

  const names = Object.keys(config.auth);
  if (chosen === undefined) {
    // Only a strategy the config supplied on its own - `auth: profileAuth()`,
    // normalised to `default` - applies without being asked for. A named map
    // never does, even when it holds exactly one entry: otherwise adding a
    // second name would silently change what every unmarked scenario does, and
    // a config with one login would quietly sign every take into it.
    const strategy = config.auth["default"];
    return !strategy || strategy.name === "none" ? null : strategy;
  }

  const strategy = config.auth[chosen];
  if (!strategy) {
    throw new ScreencastError(`Unknown auth strategy: ${chosen}`, "UNKNOWN_AUTH", [
      names.length > 0
        ? `This config defines: ${names.join(", ")}`
        : "No auth strategies are configured. Add one under `auth` in screencast.config.ts",
      "Use `--no-auth` to record signed out",
    ]);
  }
  return strategy.name === "none" ? null : strategy;
}
