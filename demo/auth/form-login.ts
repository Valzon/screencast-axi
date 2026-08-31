import type { AuthStrategy } from "screencast-axi";

/**
 * A project's own sign-in, written as a strategy.
 *
 * This is the extension point: whatever your app's login is, it goes here as
 * typed, debuggable code rather than a shelled-out script. It runs *before*
 * the clip starts, so none of it lands in the recording - the take opens
 * already signed in, which is the point.
 *
 * For a real app, reach for `profileAuth()` first: a person signs in by hand
 * once and every take reuses the session, which covers OAuth, SSO and
 * two-factor without anyone writing a strategy at all. This exists because the
 * demo has to be reproducible without a human, and it doubles as a worked
 * example of the interface.
 *
 * The credentials are the ones the-internet.herokuapp.com prints on its own
 * login page for exactly this purpose. Nothing here is a secret, and the page
 * it opens genuinely redirects to /login without a session - which is what
 * makes the clip worth anything.
 */
export function formLogin(): AuthStrategy {
  return {
    name: "form-login",

    async signIn(page) {
      await page.goto("https://the-internet.herokuapp.com/login", {
        waitUntil: "domcontentloaded",
      });
      await page.fill("#username", "tomsmith");
      await page.fill("#password", "SuperSecretPassword!");
      await page.click("button[type=submit]");
      await page.waitForLoadState("domcontentloaded");
      return { id: "tomsmith", label: "tomsmith" };
    },

    /**
     * The provider saying yes is not the app agreeing. Waiting for something
     * only the protected page renders is the difference between "the request
     * succeeded" and "we are actually through the door".
     */
    async assertSignedIn(page) {
      await page.locator("h2", { hasText: "Secure Area" }).first().waitFor({ state: "visible" });
    },

    describe: () => ({ strategy: "form-login", as: "tomsmith" }),
  };
}
