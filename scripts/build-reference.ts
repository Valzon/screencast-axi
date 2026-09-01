import { readFileSync, writeFileSync } from "node:fs";
import { format, resolveConfig } from "prettier";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_REFERENCE } from "../src/reference.js";

/**
 * Regenerates the command reference inside README.md, between its markers.
 *
 * Written from the flag specs the CLI actually parses, so the table cannot
 * quietly stop matching the tool. `--check` fails CI when they diverge.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = join(root, "README.md");
const START = "<!-- reference:start -->";
const END = "<!-- reference:end -->";

const current = readFileSync(readme, "utf8");
const from = current.indexOf(START);
const to = current.indexOf(END);
if (from === -1 || to === -1) {
  console.error(`README.md is missing the ${START} / ${END} markers`);
  process.exit(1);
}

const spliced =
  current.slice(0, from + START.length) + "\n\n" + COMMAND_REFERENCE() + "\n" + current.slice(to);

// Formatted here, so the generator's output is byte-identical to what
// `prettier --write` would produce. Otherwise the two fight: the formatter
// reflows the generated tables and the drift check fails on its own output.
const next = await format(spliced, {
  ...(await resolveConfig(readme)),
  filepath: readme,
});

if (process.argv.includes("--check")) {
  if (next !== current) {
    console.error("README.md command reference is out of date. Run `pnpm build:reference`.");
    process.exit(1);
  }
  console.log("README.md command reference is up to date");
} else {
  writeFileSync(readme, next);
  console.log("wrote the command reference into README.md");
}
