import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineScenario } from "screencast-axi";

/**
 * The clip in the README, in three acts: the ask, the work, the result.
 *
 * The first two acts are local pages in `demo/stage/`, opened over `file://`.
 * A scenario is ordinary TypeScript, so it can compute those paths the same
 * way any Node module would - and driving a local page is no different to
 * driving a remote one as far as the recorder is concerned.
 *
 * The third act is a real public app, driven for real. That is the claim the
 * tool makes, so the demo had better be an actual recording of it.
 */
const stageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "stage");
const stage = (file: string) => pathToFileURL(join(stageDir, file)).href;

export default defineScenario({
  id: "demo",
  title: "From a sentence to a screencast",
  description:
    "Asking for a clip, the scenario that gets written, and the recording it produces - itself recorded by screencast-axi.",

  steps: [
    "Ask for the clip you want",
    "It writes a scenario and rehearses it",
    "Then it drives the real app",
    "Typed the way a person types it",
    "And the app answers, on camera",
  ],

  async run(d) {
    // Act one: the ask.
    await d.goto(stage("prompt.html"));
    await d.step(0, 600);
    await d.type("#prompt", "Record a 10 second clip of adding a task, for the README", {
      delay: 42,
    });
    await d.press("Enter");
    await d.beat(1100);

    // Act two: what came back.
    await d.goto(stage("work.html"));
    await d.step(1, 3000);

    // Act three: the real thing.
    await d.goto("/examples/react/dist/");
    await d.waitFor(".new-todo");
    await d.step(2, 1500);

    await d.step(3);
    await d.type(".new-todo", "Ship the demo");
    await d.press("Enter");
    await d.beat(700);

    await d.step(4);
    await d.click(".todo-list li:first-child .toggle");
    await d.beat(1000);
  },
});
