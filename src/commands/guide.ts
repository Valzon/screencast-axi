import { ScreencastError } from "../errors.js";
import { parseFlags } from "../flags.js";
import type { AxiStructuredOutput } from "../output.js";

/**
 * Topic-sized guidance, pulled one topic at a time.
 *
 * This is the token lever: the installed skill stays a small discovery stub
 * and the agent reads only the topics its task needs, instead of loading a
 * manual it will mostly not use. Topics are added here as the features they
 * describe land - a topic that documents something unbuilt would be worse
 * than no topic at all.
 */
interface Topic {
  readonly summary: string;
  readonly body: readonly string[];
}

const TOPICS: Record<string, Topic> = {
  overview: {
    summary: "What this tool does, and what is built so far",
    body: [
      "screencast-axi records a scripted browser workflow as a watchable clip:",
      "a scenario is a TypeScript file that drives Playwright through a flow,",
      "and the recorder overlays a synthetic cursor and captions, then encodes",
      "the capture to mp4, webm and a poster image.",
      "",
      "The loop is: `scaffold` writes a skeleton, you fill in the run() body,",
      "`rehearse` proves the selectors without encoding, and `record` shoots",
      "the real take and writes the manifest.",
      "",
      "For a page behind a login, see `guide auth`: a person signs in by hand",
      "once and every take afterwards reuses the session.",
    ],
  },
  encoding: {
    summary: "Output formats, why not GIF, and what has to be installed",
    body: [
      "Every take produces an mp4 (h264, faststart), a webm (VP9) and a poster",
      "image. GIF is opt-in and is an export, not a storage format.",
      "",
      "Measured on a real 16.7s app screencast, all at 800px wide and 15fps:",
      "  mp4 (h264)              182 KB",
      "  animated WebP (q55)     944 KB   5.2x",
      "  animated WebP (q70)   1,875 KB  10.3x",
      "  GIF (192 colours)     2,034 KB  11.2x",
      "The source mp4 at full 1280px and 30fps is 471 KB - still 4.3x smaller",
      "than the GIF at half the resolution and half the frame rate.",
      "",
      "Quality is not the deciding factor for flat app UI: 192 colours plus",
      "dithering keeps small text legible. Size and capability are. A GIF has",
      "no controls, no seeking, no poster frame, cannot be paused, and ignores",
      "prefers-reduced-motion. Reach for it only where video does not render -",
      "an npm README, an email - and prefer <video autoplay muted loop",
      "playsinline> everywhere else.",
      "",
      "ffmpeg is required and is not bundled: it is 80MB+ per platform, and",
      "which build you have matters. Many builds - Homebrew's among them - ship",
      "without libwebp, so the poster falls back from ffmpeg to cwebp to PNG.",
      "A missing WebP encoder costs you file size, never a recording.",
      "",
      "ffmpeg is looked up in this order: $SCREENCAST_FFMPEG, then an installed",
      "`ffmpeg-static` (add it as a dev dependency if you would rather not",
      "install ffmpeg system-wide), then PATH.",
    ],
  },

  mobile: {
    summary: "Recording a phone or tablet clip",
    body: [
      "Use a Playwright device preset rather than a bare size:",
      '  screencast-axi record tour --device "iPhone 13" --orientation portrait',
      "",
      "A preset carries more than a width. Its deviceScaleFactor (2-3 on",
      "phones) is what the page renders at, and the recorder captures at those",
      "device pixels - the difference between readable UI text and a smear.",
      "Its isMobile and hasTouch flags decide whether the page's own",
      "@media (hover: none) rules apply at all, so a desktop context resized to",
      "phone width is not the same test.",
      "",
      "The deliverable is never scaled beyond what was captured, so a phone",
      "clip stays small. Playwright ships 140+ presets; the names are its own",
      "and are case-sensitive. `--viewport 390x844` works when no preset fits.",
    ],
  },
  duration: {
    summary: "Aiming a clip at a length",
    body: [
      "  screencast-axi record tour --duration 30s",
      "",
      "The recorder runs one measuring pass without encoding, then solves for",
      "the pace that lands near the target and shoots the real take. Accepts",
      "30s, 1m30s, or a bare number of seconds.",
      "",
      "A take is `fixed + pace x scalable`: every pause the recorder controls",
      "scales, and the site's own waits - navigation, network, animation - do",
      "not, because slowing the recorder down does not slow the site down. The",
      "measuring pass reports both halves, so the solve is exact rather than an",
      "assumption that everything scales.",
      "",
      "Pace is clamped to 0.4-2.5. Outside that a clip stops being watchable,",
      "so a target that needs more is reported rather than obeyed: the honest",
      "answer is that the scenario has too much or too little in it for the",
      "length you asked for.",
    ],
  },
  tour: {
    summary: "Multi-page walkthroughs",
    body: [
      "`d.tour(stops)` is the shape most walkthrough requests have. Each stop",
      "navigates, narrates, dwells, and optionally scrolls:",
      "",
      "  await d.tour([",
      '    { path: "/",        step: 0, scroll: 0.6 },',
      '    { path: "/pricing", step: 1, scroll: 0.5 },',
      '    { path: "/docs",    step: 2 },',
      "  ]);",
      "",
      "`step` indexes the scenario's `steps`. `scroll` of 1 or less is a share",
      "of the viewport, so it reads the same on a phone and a desktop; larger",
      "values are pixels. `waitFor` holds the narration until something is on",
      "screen, so a slow page does not get a jump cut.",
      "",
      "`screencast-axi scaffold <id> --tour 5` writes the whole skeleton.",
      "Every pause is pace-scaled, so --duration re-cuts a tour untouched.",
    ],
  },
  auth: {
    summary: "Recording a page that is behind a login",
    body: [
      "The default is signed out. For anything behind a login, the strategy",
      "that needs no code for the site you are recording is `profileAuth()`:",
      "",
      "  // screencast.config.ts",
      '  browser: { profileDir: ".screencast/profile" },',
      '  auth: profileAuth({ signedInSelector: "[data-testid=user-menu]" }),',
      "",
      "Then a person runs, once, in their own terminal:",
      "  npx -y screencast-axi auth login --interactive",
      "A browser opens, they sign in however that site wants - OAuth, SSO, a",
      "magic link, two-factor - and close the window. The session lives in the",
      "profile and every take reuses it. No credential is handled by this tool.",
      "",
      "`auth login` never reads stdin. Without a terminal, or without",
      "--interactive, it refuses with NEEDS_HUMAN and names who has to run it -",
      "a CLI that blocks on input inside an agent loop is a hang, not a prompt.",
      "",
      "Also shipped: `storageStateAuth({ path })` for a portable session file",
      "(CI-friendly, but needs an isolated context so it cannot be combined",
      "with profileDir), and `basicAuth({ username, password })` for staging",
      "environments. Anything else is an `AuthStrategy` object written in the",
      "config, which is typed and debuggable.",
      "",
      "Set `signedInSelector` or `signedInCookie`. Without one nothing is",
      'verified, and "the URL is not /login" is a false pass - a build-error',
      "page satisfies it too.",
      "",
      "Recording a live production site: a scenario that creates or drags",
      "something writes to production. Prefer read-only scenarios there, or",
      "point at staging. The profile holds a real session, so gitignore it.",
    ],
  },
  overlay: {
    summary: "The synthetic cursor, captions and drag ghost, and how to theme them",
    body: [
      "Playwright's video contains no mouse pointer, which makes any clip of a",
      "click or a drag unreadable. The recorder injects an overlay that draws a",
      "pointer following the real one, a click ripple, a drag ghost and a",
      "caption bar - all inside a shadow root, so no page CSS can reach them.",
      "",
      "Everything is themeable: accent colour, pointer shape, caption position,",
      "typography and fade. `hideSelectors` removes page chrome that should not",
      "appear in footage - a framework error badge, a cookie banner, a staging",
      "ribbon.",
      "",
      "The overlay re-mounts itself if the page replaces its document, because",
      "that detaches the overlay while leaving its API in place. Without the",
      "recovery, captions would stop appearing and the take would keep",
      "recording as though nothing were wrong.",
    ],
  },
};

export function guideCommand(args: string[]): AxiStructuredOutput {
  // No flags of its own, but it still goes through the parser so an unknown
  // flag is rejected here exactly as it is everywhere else.
  const { positionals } = parseFlags(args, {});
  const [topic, ...rest] = positionals;

  if (rest.length > 0) {
    throw new ScreencastError(`Unexpected argument: ${rest[0]}`, "VALIDATION_ERROR", [
      "Run `screencast-axi guide <topic>` with a single topic",
      "Run `screencast-axi guide` to list the topics",
    ]);
  }

  if (!topic) {
    return {
      topics: Object.entries(TOPICS).map(([name, t]) => ({ topic: name, summary: t.summary })),
      help: ["Run `screencast-axi guide overview` to start"],
    };
  }

  const found = TOPICS[topic];
  if (!found) {
    throw new ScreencastError(`Unknown guide topic: ${topic}`, "VALIDATION_ERROR", [
      `Available topics: ${Object.keys(TOPICS).join(", ")}`,
      "Run `screencast-axi guide` to list them with summaries",
    ]);
  }

  return { topic, summary: found.summary, guidance: found.body.join("\n") };
}

export function guideHelp(): string {
  return `${[
    `command: guide`,
    `description: Topic-sized guidance, pulled one topic at a time`,
    ``,
    `usage:`,
    `  screencast-axi guide           List the available topics`,
    `  screencast-axi guide <topic>   Print one topic`,
    ``,
    `topics: ${Object.keys(TOPICS).join(", ")}`,
  ].join("\n")}\n`;
}
