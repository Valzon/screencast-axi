import { defineConfig } from "screencast-axi";
import { formLogin } from "./auth/form-login.ts";

/**
 * The config behind the clip in the README.
 *
 * Kept in the repo so the demo is reproducible: `pnpm demo` re-records it, and
 * anyone can read exactly what produced the image they are looking at.
 */
export default defineConfig({
  // Origin only. A baseUrl with a path is a trap: `goto("/")` resolves
  // against the origin, so the path would be silently dropped.
  baseUrl: "https://todomvc.com",
  scenarios: ["scenarios/*.ts"],
  viewport: { width: 880, height: 520 },
  outDir: "../docs",

  // Named, so a scenario opts in with `auth: "demo"` and everything else
  // records signed out.
  auth: { demo: formLogin() },

  deliverables: {
    // Small on purpose: this loads on every view of the README.
    width: 900,
    gifWidth: 640,
    gifFps: 12,
    animatedWebpQuality: 60,
  },

  overlay: {
    accent: "#3b82f6",
    caption: { offset: 26, fontSize: 18 },
    // TodoMVC's docs sidebar is pinned to the left of the viewport and is not
    // part of the app being demonstrated. This is what hideSelectors is for:
    // page chrome that should not end up in the footage.
    hideSelectors: [".learn"],
  },
});
