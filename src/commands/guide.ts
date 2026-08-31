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
      "Build status: the recorder core is in place (the action API, the page",
      "overlay, the encode pipeline) but nothing wires it to a command yet -",
      "there is no `record` verb, no scenario discovery and no auth. Until",
      "there is, the pieces are usable only as a library import.",
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
