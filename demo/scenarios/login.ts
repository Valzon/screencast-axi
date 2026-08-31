import { defineScenario } from "screencast-axi";

/**
 * Recording a sign-in.
 *
 * A login is an ordinary workflow as far as the recorder is concerned - a
 * field, a field, a button - and it is worth showing on camera because it is
 * the part of a product most demos skip. The credentials here are the ones
 * the-internet.herokuapp.com prints on its own login page for this purpose.
 *
 * The alternative, for a real app, is to skip it: an auth strategy signs in
 * before recording starts so the take opens already through the door. See
 * `demo/auth/form-login.ts` and `guide auth`.
 */
export default defineScenario({
  id: "usecase-login",
  title: "Recording a sign-in",
  description: "Typing credentials into a real login form and landing on the page behind it.",
  baseUrl: "https://the-internet.herokuapp.com",
  viewport: { width: 900, height: 540 },
  // Signed out on purpose: the sign-in is the thing being filmed.
  auth: false,

  overlay: { caption: { fontSize: 24, offset: 22, padding: "11px 20px" } },

  steps: [
    "A real login form",
    "Username, then password",
    "Submitted for real",
    "And the page behind it",
  ],

  async run(d) {
    await d.goto("/login");
    await d.waitFor("#username");
    await d.step(0, 1100);

    await d.step(1);
    await d.type("#username", "tomsmith", { delay: 55 });
    await d.type("#password", "SuperSecretPassword!", { delay: 45 });
    await d.beat(500);

    await d.step(2);
    await d.click("button[type=submit]");
    await d.waitFor("h2");
    await d.beat(600);

    await d.step(3, 1600);
  },
});
