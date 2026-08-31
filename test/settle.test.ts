import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { DEFAULT_SETTLE_MS, Director } from "../src/director.js";

/**
 * Regression: `goto` used to wait for `networkidle` on the default timeout and
 * swallow the failure, so any site that never goes quiet - analytics,
 * websockets, polling; GitHub does not go quiet, ever - put up to 30 seconds
 * of dead air *inside the recorded clip*, invisibly. It also made a rehearsal
 * and a take disagree, since the two use different default timeouts, which
 * made duration targeting wrong by a factor of two on exactly the busy sites
 * people want to record.
 *
 * The page here keeps one request open forever, so `networkidle` can never
 * fire. What is asserted is that `goto` gives up quickly regardless.
 */
describe("navigating a page that never goes quiet", () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/never-ends") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("holding");
        return; // deliberately never ends
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<body><h1>busy</h1><script>fetch('/never-ends');</script></body>");
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("gives up on the settle wait instead of recording dead air", async () => {
    const page = await browser.newPage();
    const director = new Director(page, { baseUrl, pace: 1 }, Date.now());

    const started = Date.now();
    await director.goto("/");
    const elapsed = Date.now() - started;

    // Comfortably under Playwright's 30s default, which is what used to apply.
    expect(elapsed).toBeLessThan(DEFAULT_SETTLE_MS + 4000);
    // And it really did wait for the page, rather than skipping the settle.
    expect(await page.locator("h1").textContent()).toBe("busy");
    await page.close();
  }, 60_000);

  it("honours a shorter settle budget", async () => {
    const page = await browser.newPage();
    const director = new Director(page, { baseUrl, pace: 1, settleMs: 300 }, Date.now());

    const started = Date.now();
    await director.goto("/");
    expect(Date.now() - started).toBeLessThan(DEFAULT_SETTLE_MS);
    await page.close();
  }, 60_000);
});
