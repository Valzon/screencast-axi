import { AxiError } from "axi-sdk-js";
import type { AxiStructuredOutput } from "../types.js";

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
      "Build status: this version ships the CLI shell only. The recorder,",
      "scenario authoring, auth and encoding are not wired up yet, so there is",
      "nothing to record with. Run `screencast-axi --version` to check what you",
      "have, and see the repository README for the roadmap.",
    ],
  },
};

export function guideCommand(args: string[]): AxiStructuredOutput {
  const [topic, ...rest] = args;

  if (rest.length > 0) {
    throw new AxiError(`Unexpected argument: ${rest[0]}`, "VALIDATION_ERROR", [
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
    throw new AxiError(`Unknown guide topic: ${topic}`, "VALIDATION_ERROR", [
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
