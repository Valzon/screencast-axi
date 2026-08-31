import { defineScenario } from "screencast-axi";

/**
 * A phone clip, captured at real device pixels.
 *
 * The preset is doing more than setting a width: its deviceScaleFactor is what
 * the page renders at, and recording at the CSS viewport instead would put out
 * a clip whose text is a smear. Its isMobile and hasTouch flags also decide
 * whether the site's own `@media (hover: none)` rules apply, so this is the
 * mobile layout rather than a desktop one squeezed narrow.
 */
export default defineScenario({
  id: "usecase-mobile",
  title: "The same workflow, on a phone",
  description: "A mobile-shaped take of adding a task, at the device's own pixel density.",
  baseUrl: "https://todomvc.com",
  device: "iPhone 13",
  orientation: "portrait",

  // Shown at roughly a third of the recorded width in the README, so the
  // caption is sized to survive the downscale.
  overlay: { caption: { fontSize: 22, offset: 26, padding: "10px 18px" } },

  steps: ["The real mobile layout", "Typed on the phone", "And there it is"],

  async run(d) {
    await d.goto("/examples/react/dist/");
    await d.waitFor(".new-todo");
    await d.step(0, 1200);

    await d.step(1);
    await d.type(".new-todo", "Pack for the trip", { delay: 60 });
    await d.press("Enter");
    await d.beat(700);

    await d.step(2, 1300);
  },
});
