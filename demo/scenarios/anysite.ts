import { defineScenario } from "screencast-axi";

/**
 * A site the tool knows nothing about, driven through a real multi-step task.
 *
 * The point is that there is no integration here: no plugin for Wikipedia, no
 * fixture, no test IDs added to the page. It is a public site and a scenario
 * that describes what to do on it, which is the whole proposition - point it
 * at whatever you have and write down the workflow.
 */
export default defineScenario({
  id: "usecase-anysite",
  title: "Any site, any workflow",
  description:
    "Searching Wikipedia, opening an article and jumping to a section - on a site with no special support of any kind.",
  baseUrl: "https://www.wikipedia.org",
  viewport: { width: 1160, height: 620 },

  overlay: { caption: { fontSize: 25, offset: 24, padding: "12px 22px" } },

  steps: [
    "Start anywhere",
    "Type the search the way a person would",
    "Live suggestions, as they arrive",
    "Open the article",
    "Then jump to the section that matters",
  ],

  async run(d) {
    await d.goto("/");
    await d.waitFor("#searchInput");
    await d.step(0, 900);

    await d.step(1);
    await d.type("#searchInput", "Ada Lovelace", { delay: 75 });

    await d.step(2);
    await d.waitFor(".suggestion-link");
    await d.beat(1100);

    await d.step(3);
    await d.press("Enter");
    await d.waitFor("#firstHeading");
    await d.beat(1200);

    await d.step(4);
    await d.click("#vector-toc a[href='#Work']");
    await d.beat(1600);
  },
});
