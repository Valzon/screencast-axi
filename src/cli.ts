import { AxiError, runAxiCli } from "axi-sdk-js";
import { isScreencastError } from "./errors.js";
import { VERSION } from "./version.js";
import { homeView } from "./commands/home.js";
import { guideCommand, guideHelp } from "./commands/guide.js";

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
  `  guide [topic]        Topic-sized guidance. Run bare to list topics`,
  ``,
  `flags must come after the command. \`--version\`, \`--help\` excepted.`,
].join("\n")}\n`;

const COMMAND_HELP: Record<string, string> = {
  guide: guideHelp(),
};

/**
 * The one place the SDK's error type is constructed.
 *
 * Everything below the CLI throws `ScreencastError`, so the library half of
 * this package stays free of an ESM-only dependency that a CJS resolver
 * cannot follow. Converting here keeps the wire format identical.
 */
function toAxi<T>(handler: (args: string[]) => T): (args: string[]) => T {
  return (args) => {
    try {
      return handler(args);
    } catch (error) {
      if (isScreencastError(error)) {
        throw new AxiError(error.message, error.code, error.suggestions);
      }
      throw error;
    }
  };
}

export async function main(argv?: string[]): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    ...(argv ? { argv } : {}),
    home: () => homeView(),
    commands: {
      guide: toAxi((args) => guideCommand(args)),
    },
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}
