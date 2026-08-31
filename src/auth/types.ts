import type { BrowserContext, Page } from "playwright";

/**
 * How a take gets past a login.
 *
 * The four jobs the interface separates were, in the recorder this grew out
 * of, one 300-line function - and the seams matter:
 *
 * - `preflight` runs before the browser opens, so "the auth server is down" is
 *   discovered in a second rather than mid-take, after the capture has already
 *   started rolling.
 * - `assertSignedIn` is separate from `signIn` because they answer different
 *   questions. The provider saying yes is not the app agreeing: a build-error
 *   page, or an app that never booted, sails past any check based on the URL.
 *   Naming it in the interface means a new strategy cannot skip it by
 *   accident.
 * - `interactiveLogin` is the human-in-the-loop path, kept apart because it is
 *   the one thing that cannot run unattended.
 */

export interface AuthIdentity {
  /** Stable id, if the strategy knows one. */
  readonly id: string;
  /** What to print: an email, a username, a profile name. Never a secret. */
  readonly label: string;
}

export interface AuthPreflightContext {
  readonly baseUrl: string;
  /** Directory the config was loaded from; relative paths anchor here. */
  readonly rootDir: string;
  log(message: string): void;
}

export interface AuthContext extends AuthPreflightContext {
  readonly scenario: { readonly id: string; readonly title: string };
}

/** Context options a strategy can set before any page exists. */
export interface ContextPatch {
  readonly storageState?: string;
  readonly httpCredentials?: { readonly username: string; readonly password: string };
}

export interface AuthStrategy {
  readonly name: string;
  /** No browser: env vars present, a file on disk, a host reachable. */
  preflight?(ctx: AuthPreflightContext): Promise<void>;
  /** Cookies, storage state, HTTP credentials - applied at context creation. */
  prepareContext?(ctx: AuthPreflightContext): ContextPatch;
  /** Page-level sign-in. Returns who the take is now running as. */
  signIn?(page: Page, ctx: AuthContext): Promise<AuthIdentity>;
  /** Proves the app agrees someone is signed in, not just the provider. */
  assertSignedIn?(page: Page, ctx: AuthContext): Promise<void>;
  /**
   * Opens a browser for a human to sign in by hand.
   *
   * Resolves when they are done - normally when they close the window. A
   * strategy without this reports that `auth login` does not apply to it.
   */
  interactiveLogin?(context: BrowserContext, page: Page, ctx: AuthContext): Promise<void>;
  /** Non-secret fields for `auth check` and `doctor` to print. */
  describe?(): Record<string, string | number | boolean>;
}

export type AuthConfig = AuthStrategy | Record<string, AuthStrategy>;
