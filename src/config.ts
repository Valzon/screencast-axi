import { ScreencastError } from "./errors.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_ENCODE_SETTINGS, type EncodeSettings } from "./encode.js";
import { DEFAULT_OVERLAY_THEME, type DeepPartial, type OverlayTheme } from "./overlay.js";
import { isScenario, type DefinedScenario, type Viewport } from "./types.js";
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
async function importModule(file: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(file).href;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string }).code;
    const needsLoader =
      code === "ERR_UNKNOWN_FILE_EXTENSION" ||
      (error instanceof SyntaxError && /\.m?ts$/.test(file));
    if (!needsLoader || tsxRegistered) throw error;

    try {
      const specifier = "tsx/esm/api";
      const tsx = (await import(specifier)) as { register?: () => void };
      tsx.register?.();
      tsxRegistered = true;
    } catch {
      throw new ScreencastError(
        `Cannot load ${file}: this Node cannot run TypeScript directly`,
        "TS_LOADER_MISSING",
        ["Install the loader: `pnpm add -D tsx`", "Or write the file as .mjs instead of .ts"],
      );
    }
    // Cache-bust so the retry does not get the failed module record back.
    return (await import(`${url}?tsx=1`)) as Record<string, unknown>;
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
    const found = Object.values(module).filter(isScenario);

    if (found.length === 0) {
      throw new ScreencastError(`No scenario exported by ${file}`, "NO_SCENARIO", [
        "Wrap the object: `export default defineScenario({ ... })`",
        "`defineScenario` is imported from `screencast-axi`",
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
    const only = names.length === 1 ? names[0] : undefined;
    const name = config.auth["default"] ? "default" : only;
    const strategy = name ? config.auth[name] : undefined;
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
