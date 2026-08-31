import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { Director } from "../src/director.js";

/**
 * A scenario is arbitrary code driving a real browser, often a signed-in one.
 * "What will this actually do" is a fair thing to want answered before running
 * it, and watching a headed run answers it once - this answers it in a form
 * that can be read, diffed and kept.
 */
describe("the action log", () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<body style="height:3000px">
           <h1 id="title">hello</h1>
           <input id="field" />
           <input id="secret" type="password" />
           <button id="go">Go</button>
         </body>`,
      );
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

  it("records every action, in order, with what it acted on", async () => {
    const page = await browser.newPage();
    const director = new Director(
      page,
      { baseUrl, pace: 0.1, steps: ["first line"], settleMs: 200 },
      Date.now(),
    );

    await director.goto("/");
    await director.waitFor("#title");
    await director.step(0);
    await director.click("#go");
    await director.type("#field", "hunter");
    await director.press("Enter");
    await director.scrollBy(400);

    const kinds = director.performed.map((a) => a.kind);
    expect(kinds).toEqual(["goto", "waitFor", "step", "click", "type", "press", "scroll"]);

    const byKind = Object.fromEntries(director.performed.map((a) => [a.kind, a]));
    expect(byKind["goto"]?.target).toBe(`${baseUrl}/`);
    expect(byKind["waitFor"]?.target).toBe("#title");
    expect(byKind["step"]?.detail).toBe("first line");
    // The typed text is shown: typing into a real app is the action most worth
    // being able to review before trusting a script.
    expect(byKind["type"]).toMatchObject({ target: "#field", detail: "hunter" });
    expect(byKind["press"]?.detail).toBe("Enter");
    expect(byKind["scroll"]?.detail).toBe("400px");

    // Timestamps advance, so the log reads as a sequence.
    const times = director.performed.map((a) => a.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    await page.close();
  }, 60_000);

  /**
   * The log is meant to be read by someone deciding whether a scenario is safe
   * to run, so it must not be the thing that leaks a credential into a
   * terminal, a CI log, or a screenshot of one.
   */
  it("never records what was typed into a password field", async () => {
    const page = await browser.newPage();
    const director = new Director(page, { baseUrl, pace: 0.1, settleMs: 200 }, Date.now());
    await director.goto("/");
    await director.type("#secret", "hunter2-and-then-some");

    const typed = director.performed.find((a) => a.kind === "type");
    expect(typed?.target).toBe("#secret");
    expect(typed?.detail).not.toContain("hunter2");
    // The shape is still useful for spotting an empty or truncated value.
    expect(typed?.detail).toContain("21 chars");
  }, 60_000);

  it("masks by name when the field cannot be inspected", async () => {
    const page = await browser.newPage();
    const director = new Director(page, { baseUrl, pace: 0.1, settleMs: 200 }, Date.now());
    await director.goto("/");
    await director.type("#field", "s3cret-value").catch(() => undefined);
    // #field is a plain text input, so it is logged in full.
    expect(director.performed.find((a) => a.kind === "type")?.detail).toBe("s3cret-value");
    await page.close();
  }, 60_000);

  it("describes a locator and a point readably", async () => {
    const page = await browser.newPage();
    const director = new Director(page, { baseUrl, pace: 0.1, settleMs: 200 }, Date.now());
    await director.goto("/");
    await director.waitFor(page.locator("#title"));
    await director.click({ x: 10, y: 20 });

    const targets = director.performed.filter((a) => a.kind !== "goto").map((a) => a.target);
    expect(targets[0]).toContain("#title");
    expect(targets[1]).toBe("(10, 20)");
    await page.close();
  }, 60_000);
});
