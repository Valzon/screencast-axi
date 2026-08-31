import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ScreencastError } from "../errors.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import type { AxiStructuredOutput } from "../output.js";

export const SCAFFOLD_FLAGS: FlagSpecs = {
  url: { kind: "string", description: "Base URL the scenario opens", placeholder: "url" },
  title: { kind: "string", description: "Human title for the clip", placeholder: "text" },
  dir: { kind: "string", description: "Where to write it", placeholder: "path" },
  tour: { kind: "number", description: "Write an n-stop page walkthrough instead" },
  device: { kind: "string", description: "Playwright device preset", placeholder: "name" },
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function titleFrom(id: string): string {
  const words = id.split("-");
  const first = words[0] ?? id;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

/**
 * A scenario skeleton, so the boilerplate is never the thing that goes wrong.
 *
 * This is what makes a TypeScript-only authoring format cheap: the author -
 * often an agent - supplies only the `run()` body and the narration, not the
 * imports, the id or the shape.
 */
function template(id: string, title: string, url: string, device?: string): string {
  return `import { defineScenario } from "screencast-axi";

export default defineScenario({
  id: ${JSON.stringify(id)},
  title: ${JSON.stringify(title)},
  description: "TODO: one line describing what this clip shows.",
  baseUrl: ${JSON.stringify(url)},${device ? `\n  device: ${JSON.stringify(device)},` : ""}

  // Each line goes on screen once, in order, via d.step(i). The same array
  // becomes the manifest's step list, so the workflow is readable without
  // watching the video.
  steps: ["TODO: the first beat", "TODO: the second beat"],

  async run(d) {
    await d.goto("/");
    await d.step(0, 900);

    // TODO: drive the page. d.click, d.type, d.drag, d.scrollBy, d.waitFor.
    // Reach past them with d.page for anything they do not cover.

    await d.step(1, 1200);
  },
});
`;
}

function tourTemplate(
  id: string,
  title: string,
  url: string,
  stops: number,
  device?: string,
): string {
  const paths = ["/", "/pricing", "/docs", "/blog", "/contact"];
  const chosen = Array.from({ length: stops }, (_, i) => paths[i] ?? `/page-${i + 1}`);
  return `import { defineScenario } from "screencast-axi";

export default defineScenario({
  id: ${JSON.stringify(id)},
  title: ${JSON.stringify(title)},
  description: "TODO: one line describing what this walkthrough shows.",
  baseUrl: ${JSON.stringify(url)},${device ? `\n  device: ${JSON.stringify(device)},` : ""}

  // One line per stop, in the order they appear.
  steps: [
${chosen.map((_, i) => `    "TODO: what stop ${i + 1} shows",`).join("\n")}
  ],

  async run(d) {
${chosen
  .map(
    (path, i) =>
      `    await d.goto(${JSON.stringify(path)});\n` +
      `    await d.step(${i}, 1200);\n` +
      `    await d.scrollBy(500);`,
  )
  .join("\n\n")}
  },
});
`;
}

export function scaffoldCommand(args: string[]): AxiStructuredOutput {
  const { positionals, flags } = parseFlags(args, SCAFFOLD_FLAGS);
  const id = positionals[0];

  if (!id) {
    throw new ScreencastError("Name the scenario", "VALIDATION_ERROR", [
      "Run `screencast-axi scaffold <id> --url <url>`",
      "The id is the output file stem, e.g. `product-tour`",
    ]);
  }
  if (!ID_PATTERN.test(id)) {
    // The id is a file stem, so it has to be safe on every filesystem and
    // usable in a URL without escaping.
    throw new ScreencastError(`Invalid id: ${id}`, "VALIDATION_ERROR", [
      "Use lower-case words joined by dashes, e.g. `product-tour`",
      "The id becomes the file name of every deliverable",
    ]);
  }

  const url = (flags["url"] as string | undefined) ?? "http://localhost:3000";
  const title = (flags["title"] as string | undefined) ?? titleFrom(id);
  const device = flags["device"] as string | undefined;
  const dir = resolve(process.cwd(), (flags["dir"] as string | undefined) ?? "scenarios");
  const file = join(dir, `${id}.ts`);

  if (existsSync(file)) {
    throw new ScreencastError(`Already exists: ${file}`, "ALREADY_EXISTS", [
      "Edit it, or pick a different id",
    ]);
  }

  const stops = flags["tour"] as number | undefined;
  const body =
    stops !== undefined
      ? tourTemplate(id, title, url, Math.max(1, Math.min(12, Math.round(stops))), device)
      : template(id, title, url, device);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);

  return {
    created: file,
    id,
    help: [
      `Fill in the TODOs in ${relative(process.cwd(), file)}, then run \`screencast-axi rehearse ${relative(process.cwd(), file)}\``,
      "Rehearsing runs the scenario without encoding, so a wrong selector shows up in seconds",
      "Record it once it rehearses clean: `screencast-axi record " +
        relative(process.cwd(), file) +
        "`",
    ],
  };
}
