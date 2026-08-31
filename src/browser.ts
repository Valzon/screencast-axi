import type { Browser, BrowserContext, LaunchOptions, Page } from "playwright";
import { ScreencastError } from "./errors.js";
import type { Viewport } from "./types.js";

/**
 * Finding Playwright, and opening the context a take records in.
 *
 * Playwright is an optional peer rather than a dependency: a consuming project
 * almost always has its own, and a second copy would mean a second browser
 * download and - the one that actually bites - a `Page` type that does not
 * match the `Page` the recorder hands a scenario.
 */

export interface PlaywrightModule {
  readonly chromium: {
    launch(options?: LaunchOptions): Promise<Browser>;
    launchPersistentContext(userDataDir: string, options?: object): Promise<BrowserContext>;
  };
  readonly devices: Record<string, DevicePreset>;
}

export interface DevicePreset {
  readonly viewport: Viewport;
  readonly userAgent: string;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

/** Where a consumer's Playwright might live, best first. */
const CANDIDATES = ["playwright", "playwright-core", "@playwright/test"] as const;

let cached: { module: PlaywrightModule; specifier: string } | null = null;

export async function resolvePlaywright(): Promise<{
  module: PlaywrightModule;
  specifier: string;
}> {
  if (cached) return cached;

  const tried: string[] = [];
  for (const specifier of CANDIDATES) {
    try {
      const loaded = (await import(specifier)) as Partial<PlaywrightModule>;
      // `@playwright/test` re-exports chromium, which is why it qualifies.
      if (loaded.chromium) {
        cached = { module: loaded as PlaywrightModule, specifier };
        return cached;
      }
      tried.push(`${specifier} (no chromium export)`);
    } catch {
      tried.push(specifier);
    }
  }

  throw new ScreencastError("Playwright is not installed", "PLAYWRIGHT_MISSING", [
    "Install it: `pnpm add -D playwright`",
    "Then download the browser: `pnpm exec playwright install chromium`",
    `Looked for: ${tried.join(", ")}`,
  ]);
}

export interface ResolvedViewport {
  readonly viewport: Viewport;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  readonly userAgent?: string;
  /** The preset this came from, for the manifest and the CLI to report. */
  readonly device?: string;
}

export interface ViewportRequest {
  readonly device?: string;
  readonly viewport?: Viewport;
  readonly orientation?: "portrait" | "landscape";
  readonly deviceScaleFactor?: number;
}

/**
 * Turns a device name, an explicit viewport, or both into what a context needs.
 *
 * Device presets are worth going through rather than just setting a width:
 * they carry `deviceScaleFactor` (2-3 on phones), which is the difference
 * between a crisp phone clip and a blurry one, plus the `isMobile` and
 * `hasTouch` flags that decide whether the page's own `@media (hover: none)`
 * rules apply at all.
 */
export async function resolveViewport(
  request: ViewportRequest,
  fallback: Viewport,
): Promise<ResolvedViewport> {
  let base: ResolvedViewport = {
    viewport: request.viewport ?? fallback,
    deviceScaleFactor: request.deviceScaleFactor ?? 1,
    isMobile: false,
    hasTouch: false,
  };

  if (request.device) {
    const { module } = await resolvePlaywright();
    const preset = module.devices[request.device];
    if (!preset) {
      const names = Object.keys(module.devices);
      const near = names.filter((n) => n.toLowerCase().includes(request.device!.toLowerCase()));
      throw new ScreencastError(`Unknown device: ${request.device}`, "UNKNOWN_DEVICE", [
        near.length > 0
          ? `Did you mean: ${near.slice(0, 5).join(", ")}?`
          : `Playwright ships ${names.length} presets, e.g. ${names.slice(0, 4).join(", ")}`,
        "Device names are Playwright's own and are case-sensitive",
      ]);
    }
    base = {
      viewport: request.viewport ?? preset.viewport,
      deviceScaleFactor: request.deviceScaleFactor ?? preset.deviceScaleFactor,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
      userAgent: preset.userAgent,
      device: request.device,
    };
  }

  if (request.orientation) {
    const { width, height } = base.viewport;
    const wantsPortrait = request.orientation === "portrait";
    const isPortrait = height >= width;
    if (wantsPortrait !== isPortrait) {
      base = { ...base, viewport: { width: height, height: width } };
    }
  }

  return base;
}

export interface ContextOptions {
  readonly resolved: ResolvedViewport;
  readonly headless: boolean;
  readonly args: readonly string[];
  readonly profileDir?: string;
  /** Directory for the raw capture. Absent means no video is recorded. */
  readonly recordVideoDir?: string;
  readonly colorScheme?: "light" | "dark";
  readonly locale?: string;
  readonly timezoneId?: string;
  /** Applied by an auth strategy before any page exists. */
  readonly storageState?: string;
  readonly httpCredentials?: { readonly username: string; readonly password: string };
}

export interface OpenedContext {
  readonly context: BrowserContext;
  readonly page: Page;
  /** When the context was created - the clock the head-trim is measured from. */
  readonly createdAt: number;
  close(): Promise<void>;
}

/**
 * Opens the context a take runs in.
 *
 * A `profileDir` means a persistent context, which is what lets a session
 * someone signed into by hand survive between takes. Without one the context
 * is isolated, which is what `storageState` needs - the two are mutually
 * exclusive, and saying so is better than silently preferring one.
 */
export async function openContext(options: ContextOptions): Promise<OpenedContext> {
  if (options.profileDir && options.storageState) {
    throw new ScreencastError(
      "A persistent profile and a saved storage state cannot both be used",
      "CONFIG_CONFLICT",
      [
        "A storage state needs an isolated context; a profile needs a persistent one",
        "Drop `browser.profileDir`, or use an auth strategy that does not set storageState",
      ],
    );
  }

  const { module } = await resolvePlaywright();
  const { resolved } = options;

  const shared = {
    viewport: resolved.viewport,
    deviceScaleFactor: resolved.deviceScaleFactor,
    isMobile: resolved.isMobile,
    hasTouch: resolved.hasTouch,
    ...(resolved.userAgent ? { userAgent: resolved.userAgent } : {}),
    ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
    ...(options.httpCredentials ? { httpCredentials: options.httpCredentials } : {}),
    ...(options.recordVideoDir
      ? { recordVideo: { dir: options.recordVideoDir, size: resolved.viewport } }
      : {}),
  };

  if (options.profileDir) {
    const context = await module.chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless,
      args: [...options.args],
      ...shared,
    });
    const createdAt = Date.now();
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page, createdAt, close: () => context.close() };
  }

  const browser = await module.chromium.launch({
    headless: options.headless,
    args: [...options.args],
  });
  const context = await browser.newContext({
    ...shared,
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });
  const createdAt = Date.now();
  const page = await context.newPage();
  return {
    context,
    page,
    createdAt,
    // The capture is only finalised when the context closes, so the context
    // has to go first and the browser after it.
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
