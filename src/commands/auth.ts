import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { openContext, resolveViewport } from "../browser.js";
import { loadConfig, selectStrategy } from "../config.js";
import { ScreencastError } from "../errors.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import { parseDuration } from "../duration.js";
import type { AxiStructuredOutput } from "../output.js";
import type { AuthContext } from "../auth/types.js";

export const AUTH_FLAGS: FlagSpecs = {
  config: { kind: "string", description: "Path to a config file", placeholder: "path" },
  "base-url": { kind: "string", description: "Site to sign in to", placeholder: "url" },
  interactive: { kind: "boolean", description: "Required for `login`: opens a real browser" },
  "save-state": {
    kind: "string",
    description: "Write a Playwright storage state here as well",
    placeholder: "path",
  },
  headed: { kind: "boolean", description: "Show the browser for `check`" },
  wait: {
    kind: "string",
    description: "How long `login` waits for the window to close (default 5m)",
    placeholder: "5m",
  },
};

function contextFor(baseUrl: string, rootDir: string): AuthContext {
  return {
    baseUrl,
    rootDir,
    scenario: { id: "auth", title: "Sign-in check" },
    log: (message) => void process.stderr.write(`  ${message}\n`),
  };
}

/**
 * Whether a browser window could actually be seen by someone.
 *
 * On Linux a missing DISPLAY means no window can appear at all, so waiting for
 * one to close is dead time. macOS and Windows always have a desktop for a
 * logged-in session.
 */
function hasDisplay(): boolean {
  if (process.platform !== "linux") return true;
  return Boolean(process.env["DISPLAY"] ?? process.env["WAYLAND_DISPLAY"]);
}

async function withTimeout<T>(work: Promise<T>, ms: number, baseUrl: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ScreencastError("Timed out waiting for the sign-in window", "LOGIN_TIMEOUT", [
                "Nothing was saved. Run it again when there is time to finish signing in",
                `Give it longer with \`--wait 15m\`, or sign in at ${baseUrl} first`,
              ]),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function authCommand(args: string[]): Promise<AxiStructuredOutput> {
  const { positionals, flags } = parseFlags(args, AUTH_FLAGS);
  const [action, name] = positionals;

  if (action !== "login" && action !== "check") {
    throw new ScreencastError(
      action ? `Unknown auth action: ${action}` : "Say what to do",
      "VALIDATION_ERROR",
      [
        "`screencast-axi auth login --interactive` opens a browser to sign in by hand",
        "`screencast-axi auth check` reports whether the saved session still works",
      ],
    );
  }

  const config = await loadConfig(flags["config"] as string | undefined);
  const baseUrl = (flags["base-url"] as string | undefined) ?? config.baseUrl;
  const strategy = selectStrategy(config, undefined, name);

  if (!strategy) {
    throw new ScreencastError("No auth strategy is configured", "NO_AUTH_STRATEGY", [
      "Add one under `auth` in screencast.config.ts",
      "`profileAuth()` is the one that needs no code for the site you are recording",
      "Import it from `screencast-axi`",
    ]);
  }

  const viewport = await resolveViewport(
    { ...(config.device ? { device: config.device } : {}) },
    config.viewport,
  );
  const authCtx = contextFor(baseUrl, config.rootDir);

  if (action === "login") {
    return login(config, strategy, viewport, authCtx, flags);
  }
  return check(config, strategy, viewport, authCtx, flags);
}

type Config = Awaited<ReturnType<typeof loadConfig>>;
type Strategy = NonNullable<ReturnType<typeof selectStrategy>>;
type Viewport = Awaited<ReturnType<typeof resolveViewport>>;
type Flags = Readonly<Record<string, unknown>>;

/**
 * Opens a browser so a person can sign in by hand.
 *
 * The one command here that needs a human, and the reason the whole tool works
 * on a site nobody wrote a strategy for: OAuth, SSO, a magic link and
 * two-factor are all just "the person does the thing", and the session lands
 * in the profile.
 *
 * It never reads stdin, so an agent can open the window on the user's screen
 * rather than making them retype a command. What it must never do is hang: the
 * wait is bounded, it says on stderr what it is waiting for, and it refuses up
 * front where no window could appear (a headless Linux box has no display, so
 * nobody would ever see it and the wait would be pure dead time).
 *
 * `--interactive` stays required. An agent reaching for `auth login` without
 * meaning to involve a person should be told to, not quietly open a window.
 */
async function login(
  config: Config,
  strategy: Strategy,
  viewport: Viewport,
  authCtx: AuthContext,
  flags: Flags,
): Promise<AxiStructuredOutput> {
  if (!strategy.interactiveLogin) {
    throw new ScreencastError(
      `The \`${strategy.name}\` strategy has no interactive sign-in`,
      "NOT_SUPPORTED",
      [
        "`profileAuth()` is the strategy that signs in through a real browser",
        `\`${strategy.name}\` gets its session another way - check its own configuration`,
      ],
    );
  }

  if (flags["interactive"] !== true) {
    throw new ScreencastError("Signing in needs a person at the keyboard", "NEEDS_HUMAN", [
      "Pass `--interactive` to open a browser window for them to sign in",
      "The window has to appear on a screen someone is actually looking at",
    ]);
  }

  if (!hasDisplay()) {
    throw new ScreencastError("No display to open a browser window on", "NO_DISPLAY", [
      "Ask the user to run this on their own machine:",
      `  npx -y screencast-axi auth login --interactive --base-url ${authCtx.baseUrl}`,
      "Or produce a session file there and point `storageStateAuth` at it",
    ]);
  }

  if (!config.browser.profileDir) {
    throw new ScreencastError("No profile directory to save the session in", "CONFIG_MISSING", [
      "Set `browser.profileDir` in screencast.config.ts, e.g. `.screencast/profile`",
      "The profile is what remembers the session between takes - add it to .gitignore",
    ]);
  }

  await mkdir(config.browser.profileDir, { recursive: true });

  const opened = await openContext({
    resolved: viewport,
    headless: false,
    args: config.browser.args,
    profileDir: config.browser.profileDir,
  });

  try {
    const waitMs = flags["wait"] ? parseDuration(flags["wait"] as string) : 5 * 60_000;

    // Immediately, and to stderr: a window has appeared somewhere and the
    // process is now waiting on a human. Silence here reads as a hang.
    process.stderr.write(
      `A browser window is open at ${authCtx.baseUrl}.\n` +
        `Sign in, then close the window. Waiting up to ${Math.round(waitMs / 60_000)} minutes.\n`,
    );

    await withTimeout(
      strategy.interactiveLogin(opened.context, opened.page, authCtx),
      waitMs,
      authCtx.baseUrl,
    );

    const savePath = flags["save-state"] as string | undefined;
    let saved: string | undefined;
    if (savePath) {
      saved = isAbsolute(savePath) ? savePath : resolve(config.rootDir, savePath);
      await mkdir(dirname(saved), { recursive: true });
      await opened.context.storageState({ path: saved });
    }

    return {
      "signed in": strategy.name,
      profile: config.browser.profileDir,
      ...(saved ? { storage_state: saved } : {}),
      help: [
        "Check it took: `screencast-axi auth check`",
        "The session lives in the profile, so every take reuses it until it expires",
        ...(saved ? [] : ["Add `--save-state <path>` to also write a portable session file"]),
      ],
    };
  } finally {
    await opened.close().catch(() => undefined);
  }
}

/** Reports whether the saved session still gets past the login. */
async function check(
  config: Config,
  strategy: Strategy,
  viewport: Viewport,
  authCtx: AuthContext,
  flags: Flags,
): Promise<AxiStructuredOutput> {
  await strategy.preflight?.(authCtx);
  const patch = strategy.prepareContext?.(authCtx) ?? {};

  const opened = await openContext({
    resolved: viewport,
    headless: flags["headed"] !== true,
    args: config.browser.args,
    ...(config.browser.profileDir ? { profileDir: config.browser.profileDir } : {}),
    ...(patch.storageState ? { storageState: patch.storageState } : {}),
    ...(patch.httpCredentials ? { httpCredentials: patch.httpCredentials } : {}),
  });

  try {
    // Open the site first. A strategy that only patches the context - basic
    // auth, a storage state - never navigates on its own, and reporting
    // `landed: about:blank` next to "signed in: true" tells nobody anything.
    // A strategy that does navigate (to verify) simply moves on from here.
    await opened.page.goto(authCtx.baseUrl, { waitUntil: "domcontentloaded" });

    const identity = await strategy.signIn?.(opened.page, authCtx);
    await strategy.assertSignedIn?.(opened.page, authCtx);

    const shot = resolve(config.rawDir, "auth-check.png");
    await mkdir(config.rawDir, { recursive: true });
    await opened.page.screenshot({ path: shot }).catch(() => undefined);

    return {
      "signed in": true,
      strategy: strategy.name,
      ...(identity ? { as: identity.label } : {}),
      landed: opened.page.url(),
      screenshot: shot,
      ...(strategy.describe ? { config: strategy.describe() } : {}),
      help: [
        "Looks good. Record with `screencast-axi record <id>`",
        "Open the screenshot if the landed URL is not what you expected",
      ],
    };
  } finally {
    await opened.close().catch(() => undefined);
  }
}
