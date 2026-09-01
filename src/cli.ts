import { runAxiCli } from "axi-sdk-js";
import { encode as toon } from "@toon-format/toon";
import { isScreencastError } from "./errors.js";
import { ScenarioFailure } from "./run.js";
import { VERSION } from "./version.js";
import { homeView } from "./commands/home.js";
import { guideCommand, guideHelp } from "./commands/guide.js";
import { recordCommand, RECORD_FLAGS, REHEARSE_FLAGS } from "./commands/record.js";
import { scaffoldCommand, SCAFFOLD_FLAGS } from "./commands/scaffold.js";
import { authCommand, AUTH_FLAGS } from "./commands/auth.js";
import { listCommand, showCommand, LIST_FLAGS, SHOW_FLAGS } from "./commands/list.js";
import { checkCommand, CHECK_FLAGS } from "./commands/check.js";
import { doctorCommand, DOCTOR_FLAGS } from "./commands/doctor.js";
import { setupCommand, initCommand, SETUP_FLAGS, INIT_FLAGS } from "./commands/setup.js";
import { renderFlagHelp, type FlagSpecs } from "./flags.js";

export const DESCRIPTION =
  "Record cinematic product screencasts from scripted Playwright scenarios";

/**
 * Top-level help.
 *
 * Terse by design: the agent-facing source of truth is this block plus
 * `<command> --help`, and every line an agent reads costs tokens. Deeper
 * guidance lives behind `guide <topic>` so it is pulled a topic at a time.
 */
const TOP_LEVEL_HELP = `${[
  `usage: screencast-axi <command> [args] [flags]`,
  ``,
  `commands:`,
  `  init                 Write a config and a scenarios directory`,
  `  scaffold <id>        Write a scenario skeleton`,
  `  rehearse <id|path>   Dry run: prints what it does. --headed to watch it`,
  `  record   <id|path>   Run it for real and encode the clip`,
  `  auth login|check     Sign in by hand once, or check the saved session`,
  `  list                 Every scenario, and what needs re-shooting`,
  `  show <id>            One clip in full`,
  `  check                Manifest, scenarios and files, cross-referenced`,
  `  doctor               Everything a recording needs, checked at once`,
  `  setup                Install the browser; name what you must install`,
  `  guide [topic]        Topic-sized guidance. Run bare to list topics`,
  ``,
  `flags must come after the command. \`--version\`, \`--help\` excepted.`,
].join("\n")}\n`;

function commandHelp(name: string, description: string, usage: string[], specs: FlagSpecs): string {
  const flags = renderFlagHelp(specs);
  return `${[
    `command: ${name}`,
    `description: ${description}`,
    ``,
    `usage:`,
    ...usage.map((u) => `  ${u}`),
    ...(flags.length > 0 ? [``, `flags:`, ...flags] : []),
  ].join("\n")}\n`;
}

const COMMAND_HELP: Record<string, string> = {
  guide: guideHelp(),
  record: commandHelp(
    "record",
    "Run a scenario and encode the clip",
    [
      "screencast-axi record <id>            A scenario the config lists",
      "screencast-axi record ./tour.ts       A file, no config needed",
      "screencast-axi record --all           Every configured scenario",
    ],
    RECORD_FLAGS,
  ),
  rehearse: commandHelp(
    "rehearse",
    "Run a scenario without recording or encoding, to prove its selectors",
    ["screencast-axi rehearse <id>", "screencast-axi rehearse ./tour.ts --headed"],
    REHEARSE_FLAGS,
  ),
  auth: commandHelp(
    "auth",
    "Sign in by hand once; every take afterwards reuses the session",
    [
      "screencast-axi auth login --interactive   Opens a browser for a person to sign in",
      "screencast-axi auth check                 Reports whether the session still works",
      "screencast-axi auth check <name>          A named strategy from the config",
    ],
    AUTH_FLAGS,
  ),
  list: commandHelp(
    "list",
    "Every scenario, with what needs re-shooting",
    ["screencast-axi list", "screencast-axi list --stale", "screencast-axi list --full"],
    LIST_FLAGS,
  ),
  show: commandHelp(
    "show",
    "One clip in full: its files, sizes, narration and when it was shot",
    ["screencast-axi show product-tour"],
    SHOW_FLAGS,
  ),
  check: commandHelp(
    "check",
    "Cross-references the manifest, the scenarios and the files on disk",
    ["screencast-axi check", "screencast-axi check --fix-orphans"],
    CHECK_FLAGS,
  ),
  doctor: commandHelp(
    "doctor",
    "Checks everything a recording needs, in one pass",
    ["screencast-axi doctor"],
    DOCTOR_FLAGS,
  ),
  setup: commandHelp(
    "setup",
    "Installs the browser and names anything you have to install yourself",
    ["screencast-axi setup", "screencast-axi setup --browsers-only"],
    SETUP_FLAGS,
  ),
  init: commandHelp(
    "init",
    "Writes a config, a scenarios directory, and a gitignore entry",
    ["screencast-axi init", "screencast-axi init --url https://example.com"],
    INIT_FLAGS,
  ),
  scaffold: commandHelp(
    "scaffold",
    "Write a scenario skeleton so the boilerplate is never what goes wrong",
    [
      "screencast-axi scaffold product-tour --url https://example.com",
      "screencast-axi scaffold product-tour --url https://example.com --tour 5",
    ],
    SCAFFOLD_FLAGS,
  ),
};

/**
 * Renders an error with everything needed to act on it.
 *
 * The SDK's own error shape is message + code + suggestions, which is right
 * for a usage error but throws away the point of the forensics. A take that
 * failed on a stale selector should hand back the URL it reached, a
 * screenshot, and what each part of the selector actually matched - so the
 * next attempt is informed rather than another blind minute.
 *
 * Rendering here also means the library half never has to construct an SDK
 * error, which is what keeps it free of an ESM-only dependency.
 */
function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof ScenarioFailure) {
    const f = error.forensics;
    return {
      output: `${toon({
        error: error.message,
        code: error.code,
        scenario: error.scenarioId,
        phase: error.phase,
        ...(error.lastStep !== null ? { last_step: error.lastStep } : {}),
        ...(f.url ? { url: f.url } : {}),
        ...(f.screenshot ? { screenshot: f.screenshot } : {}),
        ...(f.nearMatches
          ? {
              near_matches: f.nearMatches.map((m) => ({
                selector: m.selector,
                count: m.count,
                visible: m.visible,
              })),
            }
          : {}),
        ...(f.notes ? { notes: f.notes } : {}),
        ...(error.suggestions.length > 0 ? { help: error.suggestions } : {}),
      })}\n`,
      exitCode: 1,
    };
  }

  if (isScreencastError(error)) {
    return {
      output: `${toon({
        error: error.message,
        code: error.code,
        ...(error.suggestions.length > 0 ? { help: error.suggestions } : {}),
      })}\n`,
      // A usage error is the caller's to fix, and exits 2 so a script can tell
      // it apart from work that ran and failed.
      exitCode: error.code === "VALIDATION_ERROR" ? 2 : 1,
    };
  }

  return {
    output: `${toon({
      error: error instanceof Error ? error.message : String(error),
      code: "UNKNOWN",
    })}\n`,
    exitCode: 1,
  };
}

export async function main(argv?: string[]): Promise<void> {
  await runAxiCli({
    formatError,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    ...(argv ? { argv } : {}),
    home: () => homeView(),
    commands: {
      guide: (args) => guideCommand(args),
      scaffold: (args) => scaffoldCommand(args),
      auth: (args) => authCommand(args),
      list: (args) => listCommand(args),
      show: (args) => showCommand(args),
      check: (args) => checkCommand(args),
      doctor: (args) => doctorCommand(args),
      setup: (args) => setupCommand(args),
      init: (args) => initCommand(args),
      record: (args) => recordCommand(args, "record"),
      rehearse: (args) => recordCommand(args, "rehearse"),
    },
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}
