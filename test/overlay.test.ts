import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { DEFAULT_OVERLAY_THEME, overlayInitScript, resolveOverlayTheme } from "../src/overlay.js";

describe("theme resolution", () => {
  it("derives translucent accents from a hex colour", () => {
    const theme = resolveOverlayTheme({ accent: "#ff0000" });
    expect(theme.accentSoft).toBe("rgba(255, 0, 0, 0.16)");
    expect(theme.accentRipple).toBe("rgba(255, 0, 0, 0.28)");
  });

  it("expands a three-digit hex", () => {
    expect(resolveOverlayTheme({ accent: "#0f0" }).accentEdge).toBe("rgba(0, 255, 0, 0.55)");
  });

  it("passes a non-hex colour through rather than mangling it", () => {
    // A named colour cannot be made translucent here; using it as given still
    // renders, which beats emitting a broken rgba().
    expect(resolveOverlayTheme({ accent: "rebeccapurple" }).accentSoft).toBe("rebeccapurple");
  });

  it("merges nested overrides without dropping siblings", () => {
    const theme = resolveOverlayTheme({ caption: { position: "top" } });
    expect(theme.caption.position).toBe("top");
    expect(theme.caption.fontSize).toBe(DEFAULT_OVERLAY_THEME.caption.fontSize);
  });
});

/**
 * The overlay is stringified into the page, which is the single most
 * breakable thing in this package: a toolchain that rewrites inner functions
 * (esbuild's `keepNames` emits `__name(fn, "fn")`) makes it throw
 * `__name is not defined` in the browser, silently, unless something is
 * listening. These run it in a real Chromium for that reason.
 */
describe("injection into a real browser", () => {
  it("mounts, captions, and survives stringification", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const pageErrors: string[] = [];
    try {
      const theme = resolveOverlayTheme({ accent: "#ff0000", hideSelectors: ["#dev-badge"] });
      await context.addInitScript({ content: overlayInitScript(theme) });
      const page = await context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("data:text/html,<body><div id='dev-badge'>dev</div><p>hello</p></body>");

      expect(await page.evaluate(() => typeof window.__screencast)).toBe("object");
      expect(pageErrors).toEqual([]);

      // hideSelectors replaces what used to be a hard-coded framework rule.
      expect(await page.locator("#dev-badge").isVisible()).toBe(false);

      const captionText = () =>
        page.evaluate(() => {
          const host = document.getElementById("__screencast_overlay");
          const el = host?.shadowRoot?.querySelector(".caption");
          return { text: el?.textContent ?? null, on: el?.classList.contains("on") ?? false };
        });

      expect(await captionText()).toEqual({ text: "", on: false });

      await page.evaluate(() => window.__screencast?.caption("Every step, in one list"));
      expect(await captionText()).toEqual({ text: "Every step, in one list", on: true });

      await page.evaluate(() => window.__screencast?.caption(null));
      expect((await captionText()).on).toBe(false);

      // The theme has to reach the shadow DOM, not just the Node-side object.
      const rippleBackground = await page.evaluate(() => {
        const host = document.getElementById("__screencast_overlay");
        const el = host?.shadowRoot?.querySelector(".ripple > i");
        return el ? getComputedStyle(el).backgroundColor : null;
      });
      expect(rippleBackground).toBe("rgba(255, 0, 0, 0.28)");

      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("re-mounts itself after the page replaces its document", async () => {
    // Regression: `setContent` (and `document.write`, and some SPA bootstraps)
    // detach the host while the realm - and so `window.__screencast` - lives
    // on. The API used to keep answering on a detached node, so captions
    // stopped appearing and the take carried on recording as if fine.
    const browser = await chromium.launch();
    const context = await browser.newContext();
    try {
      await context.addInitScript({ content: overlayInitScript(resolveOverlayTheme()) });
      const page = await context.newPage();
      await page.goto("data:text/html,<body><p>first</p></body>");
      await page.evaluate(() => window.__screencast?.caption("still here"));

      // Replaces the document in the same realm: the host is detached while
      // `window.__screencast` lives on. Chromium fires no window-level load
      // event for this, so recovery is lazy - the next API call or pointer
      // move is what brings the overlay back.
      await page.setContent("<body><p>replaced document</p></body>");
      expect(
        await page.evaluate(() => document.querySelectorAll("#__screencast_overlay").length),
      ).toBe(0);

      await page.evaluate(() => window.__screencast?.caption("still here"));

      const state = await page.evaluate(() => {
        const host = document.getElementById("__screencast_overlay");
        const el = host?.shadowRoot?.querySelector(".caption");
        return {
          hosts: document.querySelectorAll("#__screencast_overlay").length,
          connected: host?.isConnected ?? false,
          text: el?.textContent ?? null,
          on: el?.classList.contains("on") ?? false,
        };
      });
      expect(state).toEqual({ hosts: 1, connected: true, text: "still here", on: true });
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("is idempotent across navigations", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    try {
      await context.addInitScript({ content: overlayInitScript(resolveOverlayTheme()) });
      const page = await context.newPage();
      await page.goto("data:text/html,<body>one</body>");
      await page.goto("data:text/html,<body>two</body>");
      const hosts = await page.evaluate(
        () => document.querySelectorAll("#__screencast_overlay").length,
      );
      expect(hosts).toBe(1);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
