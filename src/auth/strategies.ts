import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { ScreencastError } from "../errors.js";
import type { AuthContext, AuthPreflightContext, AuthStrategy, ContextPatch } from "./types.js";

/** Signed-out. The default, and correct for most public surfaces. */
export function noAuth(): AuthStrategy {
  return { name: "none" };
}

export interface ProfileAuthOptions {
  /** Where to land after signing in, so `auth check` can prove it worked. */
  readonly landingPath?: string;
  /** Something only a signed-in page renders. The strongest check available. */
  readonly signedInSelector?: string;
  /**
   * Cookie the app sets once its own session is live.
   *
   * `name=value` checks the value too. Presence alone is a weak test: plenty
   * of sites set the same cookie to a signed-out value (GitHub sends
   * `logged_in=no`), so a name-only check quietly passes when it should not.
   */
  readonly signedInCookie?: string;
  readonly label?: string;
}

/**
 * Sign in once by hand; every take afterwards reuses the session.
 *
 * This is the strategy that makes the tool work on a site nobody wrote a
 * strategy for. The browser opens, a person signs in however that site wants -
 * OAuth, SSO, a magic link, two-factor - and closes the window. The session
 * lives in the persistent Chrome profile, so no code here has to know anything
 * about how that site authenticates, and no credential is ever handled by this
 * package.
 *
 * It needs `browser.profileDir` set, since a persistent profile is the thing
 * doing the remembering.
 */
export function profileAuth(options: ProfileAuthOptions = {}): AuthStrategy {
  return {
    name: "profile",

    async assertSignedIn(page: Page, ctx: AuthContext): Promise<void> {
      const landing = options.landingPath ?? "/";
      await page.goto(new URL(landing, ctx.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
      });

      if (options.signedInSelector) {
        try {
          await page.locator(options.signedInSelector).first().waitFor({ state: "visible" });
          return;
        } catch {
          throw notSignedIn(
            `nothing matched \`${options.signedInSelector}\` on ${page.url()}`,
            ctx,
          );
        }
      }

      if (options.signedInCookie) {
        const [name, expected] = splitCookie(options.signedInCookie);
        const deadline = Date.now() + 15_000;
        for (;;) {
          const cookies = await page.context().cookies();
          const found = cookies.find((c) => c.name === name);
          if (found && (expected === undefined || found.value === expected)) return;
          if (Date.now() > deadline) {
            throw notSignedIn(
              found
                ? `\`${name}\` is \`${found.value}\`, expected \`${expected}\``
                : `the \`${name}\` cookie never appeared`,
              ctx,
            );
          }
          await page.waitForTimeout(250);
        }
      }

      // Nothing to check against. Say so rather than implying it passed:
      // "the URL is not /login" is a false pass, since a build-error page
      // satisfies it too.
      ctx.log(
        "signed-in state was not verified - set signedInSelector or signedInCookie to check it",
      );
    },

    async interactiveLogin(_context: BrowserContext, page: Page, ctx: AuthContext): Promise<void> {
      await page.goto(ctx.baseUrl, { waitUntil: "domcontentloaded" });
      ctx.log("Sign in in the browser window, then close it when you are done.");
      // Resolves when the human closes the window, which is the signal that
      // they consider themselves signed in.
      await new Promise<void>((done) => page.on("close", () => done()));
    },

    describe: () => ({
      strategy: "profile",
      ...(options.landingPath ? { landing: options.landingPath } : {}),
      ...(options.signedInSelector ? { verifies: options.signedInSelector } : {}),
      ...(options.signedInCookie ? { verifies_cookie: options.signedInCookie } : {}),
      ...(options.label ? { as: options.label } : {}),
    }),
  };
}

export interface StorageStateOptions {
  /** Playwright storage-state JSON. Relative paths anchor to the config. */
  readonly path: string;
  readonly landingPath?: string;
  readonly signedInSelector?: string;
}

/**
 * A saved Playwright session file.
 *
 * Portable and CI-friendly in a way a Chrome profile is not: it is one JSON
 * file that can be produced once and committed to a secret store. Needs an
 * isolated context, so it cannot be combined with `browser.profileDir`.
 */
export function storageStateAuth(options: StorageStateOptions): AuthStrategy {
  const at = (root: string) =>
    isAbsolute(options.path) ? options.path : resolve(root, options.path);

  return {
    name: "storageState",

    async preflight(ctx: AuthPreflightContext): Promise<void> {
      const file = at(ctx.rootDir);
      if (!existsSync(file)) {
        throw new ScreencastError(`No saved session at ${file}`, "AUTH_NOT_READY", [
          "Create one: `screencast-axi auth login --interactive --save-state " +
            `${options.path}\``,
          "A storage state is produced once by a human and reused by every take",
        ]);
      }
    },

    prepareContext(ctx: AuthPreflightContext): ContextPatch {
      return { storageState: at(ctx.rootDir) };
    },

    async assertSignedIn(page: Page, ctx: AuthContext): Promise<void> {
      if (!options.signedInSelector) return;
      await page.goto(new URL(options.landingPath ?? "/", ctx.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
      });
      try {
        await page.locator(options.signedInSelector).first().waitFor({ state: "visible" });
      } catch {
        throw notSignedIn(
          `nothing matched \`${options.signedInSelector}\` - the saved session may have expired`,
          ctx,
        );
      }
    },

    describe: () => ({ strategy: "storageState", file: options.path }),
  };
}

export interface BasicAuthOptions {
  readonly username: string;
  readonly password: string;
}

/** HTTP basic auth, which is how most staging environments are gated. */
export function basicAuth(options: BasicAuthOptions): AuthStrategy {
  return {
    name: "basicAuth",
    prepareContext: (): ContextPatch => ({
      httpCredentials: { username: options.username, password: options.password },
    }),
    // The password is deliberately absent: `describe` output is printed.
    describe: () => ({ strategy: "basicAuth", username: options.username }),
  };
}

/** Splits `name=value` into its parts; a bare name means "any value". */
export function splitCookie(spec: string): [name: string, value: string | undefined] {
  const at = spec.indexOf("=");
  return at === -1 ? [spec, undefined] : [spec.slice(0, at), spec.slice(at + 1)];
}

function notSignedIn(reason: string, ctx: AuthContext): ScreencastError {
  return new ScreencastError(`Not signed in: ${reason}`, "NOT_SIGNED_IN", [
    `Sign in by hand once: \`screencast-axi auth login --interactive --base-url ${ctx.baseUrl}\``,
    "Then check it took: `screencast-axi auth check`",
  ]);
}
