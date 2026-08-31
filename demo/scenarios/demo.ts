import { defineScenario } from "screencast-axi";

/**
 * What the README shows.
 *
 * A real public app, driven the way a person would drive it - which is the
 * whole claim the tool makes, so the demo had better be an actual recording
 * of it rather than a mock-up.
 */
export default defineScenario({
  id: "demo",
  title: "A scripted workflow, recorded",
  description: "Adding and completing a task in a real app, with a drawn cursor and captions.",
  steps: [
    "Your scenario drives the real app",
    "Typed the way a person types it",
    "And the app responds on camera",
  ],

  async run(d) {
    await d.goto("/examples/react/dist/");
    await d.waitFor(".new-todo");
    await d.step(0, 900);

    await d.step(1);
    await d.type(".new-todo", "Record the landing page demo");
    await d.press("Enter");
    await d.beat(500);

    await d.type(".new-todo", "Ship it");
    await d.press("Enter");
    await d.beat(600);

    await d.step(2);
    await d.click(".todo-list li:first-child .toggle");
    await d.beat(900);
  },
});
