import type { Browser, BrowserContext, LaunchOptions, Page } from "playwright";
import { ScreencastError } from "./errors.js";
import { importFromProject } from "./resolve.js";
import { closest } from "./nearest.js";
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
    // Resolved from the project first: Playwright is the consumer's, and a CLI
    // running from an npx cache or a global install has none of its own.
    // `@playwright/test` re-exports chromium, which is why it qualifies.
    const loaded = await importFromProject<Partial<PlaywrightModule>>(specifier, (module) =>
      Boolean(module.chromium),
    );
    if (loaded?.chromium) {
      cached = { module: loaded as PlaywrightModule, specifier };
      return cached;
    }
    tried.push(specifier);
  }

  throw new ScreencastError("Playwright is not installed", "PLAYWRIGHT_MISSING", [
    "Install it: `pnpm add -D playwright`",
    "Then download the browser: `pnpm exec playwright install chromium`",
    `Looked for ${tried.join(", ")} in ${process.cwd()}`,
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
  /**
   * Set when an explicit viewport replaced the preset's own.
   *
   * The preset still supplies the user agent, scale factor and touch flags, so
   * this is a legitimate combination - but the page is laid out at the size
   * given, not the phone's, and a summary that printed the device name beside
   * a desktop-sized clip read as though the preset had been applied whole.
   */
  readonly viewportOverridden?: boolean;
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
      const wanted = request.device;
      const contains = names.filter((n) => n.toLowerCase().includes(wanted.toLowerCase()));
      // Substring first, because "iPhone 13" against "iPhone 13 Pro" is a
      // better answer than edit distance gives; then the nearest spelling,
      // which is what catches "iphone13" and "Nokia 3310".
      const near =
        contains.length > 0 ? contains.slice(0, 5) : [closest(wanted, names)].filter(Boolean);
      throw new ScreencastError(`Unknown device: ${wanted}`, "UNKNOWN_DEVICE", [
        ...(near.length > 0 ? [`Did you mean: ${near.join(", ")}?`] : []),
        `Playwright ships ${names.length} presets, and the names are its own and case-sensitive`,
        "`--viewport 390x844` works when no preset fits",
      ]);
    }
    const overridden =
      request.viewport !== undefined &&
      (request.viewport.width !== preset.viewport.width ||
        request.viewport.height !== preset.viewport.height);

    base = {
      viewport: request.viewport ?? preset.viewport,
      deviceScaleFactor: request.deviceScaleFactor ?? preset.deviceScaleFactor,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
      userAgent: preset.userAgent,
      device: request.device,
      ...(overridden ? { viewportOverridden: true } : {}),
    };
  }

  assertUsable(base.viewport);

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

/**
 * Bounds on a viewport, either end of which produces nonsense.
 *
 * Below the minimum there is no page to speak of - a 1x1 viewport records a
 * 2x2 video - and above the maximum Chromium gives up on allocating the
 * surface. That failure arrives as an unsettled promise rather than an error,
 * so the process exited 13 with no message at all, which is the worst way for
 * a typo in a flag to be answered.
 */
const MIN_VIEWPORT_EDGE = 120;
const MAX_VIEWPORT_EDGE = 8192;

function assertUsable(viewport: Viewport): void {
  const { width, height } = viewport;
  const tooSmall = width < MIN_VIEWPORT_EDGE || height < MIN_VIEWPORT_EDGE;
  const tooLarge = width > MAX_VIEWPORT_EDGE || height > MAX_VIEWPORT_EDGE;
  if (!tooSmall && !tooLarge) return;

  throw new ScreencastError(
    `Viewport ${width}x${height} is ${tooSmall ? "too small" : "too large"} to record`,
    "VIEWPORT_OUT_OF_RANGE",
    [
      `Each edge has to be between ${MIN_VIEWPORT_EDGE} and ${MAX_VIEWPORT_EDGE} pixels`,
      tooSmall
        ? "The smallest preset Playwright ships is around 320 pixels wide"
        : "Chromium cannot allocate a surface that large, and fails without an error of its own",
      'Use a device preset instead: --device "iPhone 13"',
    ],
  );
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

/**
 * Upper bound on either dimension of the raw capture.
 *
 * A very large desktop viewport would otherwise produce a needlessly heavy
 * capture that the deliverable scales down anyway.
 */
const MAX_CAPTURE_EDGE = 1600;

/**
 * The size the raw video is captured at.
 *
 * Never larger than the viewport. Playwright renders the page at the CSS
 * viewport and composites it into a canvas of this size *without scaling up* -
 * measured in Chromium, asking for three times the viewport puts the page in
 * the top-left corner and leaves the rest empty grey. Scaling down does work,
 * which is what the cap relies on.
 *
 * So a device preset's `deviceScaleFactor` cannot buy a sharper capture: it
 * still matters for how the page renders and lays itself out, but the video is
 * CSS-pixel resolution either way.
 */
export function captureSize(resolved: ResolvedViewport): Viewport {
  const { width, height } = resolved.viewport;
  const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(width, height));
  // Even dimensions: h264's yuv420p requires them, and rounding here avoids a
  // one-pixel scale in the encoder.
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

export interface OpenedContext {
  readonly context: BrowserContext;
  readonly page: Page;
  /** When the context was created - the clock the head-trim is measured from. */
  readonly createdAt: number;
  /**
   * When the sync mark went up, in ms after `createdAt`, for a recording.
   *
   * See {@link putUpSyncMark}: finding this mark in the capture is what ties
   * the recorder's clock to the video's.
   */
  readonly syncMarkMs?: number;
  close(): Promise<void>;
}

/** The colour of the sync mark: mid grey, which no blank page is. */
export const SYNC_MARK_COLOR = "#808080";

/** How long after the page opens the mark goes up - comfortably after the video starts. */
const SYNC_MARK_DELAY_MS = 450;

/**
 * Flashes the whole page grey for a moment, and says when.
 *
 * Playwright's video does not start when the page is created but when its
 * first frame arrives, and a frame reaches the file a little after it is
 * painted - together about 170ms on a fast machine, more on a loaded one. Every
 * time the recorder logs is on the page's clock, so without knowing that gap
 * the head-trim cut too late and a framed clip's captions landed that much
 * behind the picture. Assuming a number would be wrong somewhere; this
 * measures it on every take, in the head that is trimmed off anyway - about
 * two thirds of a second, before sign-in or setup begin.
 */
async function putUpSyncMark(page: Page, createdAt: number): Promise<number | undefined> {
  try {
    // Not straight away: a mark that goes up before the video's first frame is
    // simply the first frame, and says nothing about when the video started.
    await page.waitForTimeout(SYNC_MARK_DELAY_MS);
    await page.evaluate((color) => {
      const style = document.createElement("style");
      style.id = "__screencast_sync";
      style.textContent = `html { background: ${color} !important; } body { visibility: hidden !important; }`;
      (document.head ?? document.documentElement).appendChild(style);
    }, SYNC_MARK_COLOR);
    const at = Date.now() - createdAt;
    // Long enough for several frames to carry it, short enough not to matter.
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById("__screencast_sync")?.remove());
    return at;
  } catch {
    // A page that will not run script cannot be marked; the take still records,
    // on the old assumption that the clocks agree.
    return undefined;
  }
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
      ? { recordVideo: { dir: options.recordVideoDir, size: captureSize(resolved) } }
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
    const syncMarkMs = options.recordVideoDir ? await putUpSyncMark(page, createdAt) : undefined;
    return {
      context,
      page,
      createdAt,
      ...(syncMarkMs !== undefined ? { syncMarkMs } : {}),
      close: () => context.close(),
    };
  }

  const browser = await module.chromium.launch({
    headless: options.headless,
    args: [...options.args],
  });
  const context = await browser.newContext({
    ...shared,
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });
  // After the page, not before it: the page's video cannot start before the
  // page exists. The sync mark measures whatever gap is left.
  const page = await context.newPage();
  const createdAt = Date.now();
  const syncMarkMs = options.recordVideoDir ? await putUpSyncMark(page, createdAt) : undefined;
  return {
    context,
    page,
    createdAt,
    ...(syncMarkMs !== undefined ? { syncMarkMs } : {}),
    // The capture is only finalised when the context closes, so the context
    // has to go first and the browser after it.
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}
