import { AUTH_FLAGS } from "./commands/auth.js";
import { CHECK_FLAGS } from "./commands/check.js";
import { DOCTOR_FLAGS } from "./commands/doctor.js";
import { GUIDE_FLAGS } from "./commands/guide.js";
import { LIST_FLAGS, SHOW_FLAGS } from "./commands/list.js";
import { RECORD_FLAGS, REHEARSE_FLAGS } from "./commands/record.js";
import { SCAFFOLD_FLAGS } from "./commands/scaffold.js";
import { INIT_FLAGS, SETUP_FLAGS } from "./commands/setup.js";
import type { FlagSpecs } from "./flags.js";

/**
 * The command reference, built from the specs the CLI actually parses.
 *
 * Generated rather than written, for the same reason the skill is: a table of
 * flags maintained by hand stops being true the first time someone adds one,
 * and a stale reference is worse than none.
 */
interface Entry {
  readonly command: string;
  readonly summary: string;
  readonly usage: string;
  readonly flags: FlagSpecs;
}

const COMMANDS: readonly Entry[] = [
  {
    command: "init",
    summary: "Write a config, a scenarios directory and a gitignore entry",
    usage: "screencast-axi init",
    flags: INIT_FLAGS,
  },
  {
    command: "scaffold",
    summary: "Write a scenario skeleton so the boilerplate is never what goes wrong",
    usage: "screencast-axi scaffold <id>",
    flags: SCAFFOLD_FLAGS,
  },
  {
    command: "rehearse",
    summary: "Run a scenario without recording, and print every action it took",
    usage: "screencast-axi rehearse <id|path...>",
    flags: REHEARSE_FLAGS,
  },
  {
    command: "record",
    summary: "Run a scenario for real and encode the clip",
    usage: "screencast-axi record <id|path...>",
    flags: RECORD_FLAGS,
  },
  {
    command: "list",
    summary: "Every scenario, with what needs re-shooting",
    usage: "screencast-axi list",
    flags: LIST_FLAGS,
  },
  {
    command: "show",
    summary: "One clip in full: files, sizes, narration, when it was shot",
    usage: "screencast-axi show <id>",
    flags: SHOW_FLAGS,
  },
  {
    command: "check",
    summary: "Cross-reference the manifest, the scenarios and the files on disk",
    usage: "screencast-axi check",
    flags: CHECK_FLAGS,
  },
  {
    command: "doctor",
    summary: "Check everything a recording needs, in one pass",
    usage: "screencast-axi doctor",
    flags: DOCTOR_FLAGS,
  },
  {
    command: "setup",
    summary: "Install the browser; name anything you must install yourself",
    usage: "screencast-axi setup",
    flags: SETUP_FLAGS,
  },
  {
    command: "auth",
    summary: "Sign in by hand once, or check the saved session still works",
    usage: "screencast-axi auth login|check [name]",
    flags: AUTH_FLAGS,
  },
  {
    command: "guide",
    summary: "Topic-sized guidance, pulled one topic at a time",
    usage: "screencast-axi guide [topic]",
    flags: GUIDE_FLAGS,
  },
];

function renderFlags(flags: FlagSpecs): string {
  const entries = Object.entries(flags);
  if (entries.length === 0) return "_No flags._\n";
  const rows = entries.map(([name, spec]) => {
    const left =
      spec.kind === "boolean" ? `--${name}` : `--${name} <${spec.placeholder ?? "value"}>`;
    const repeat = spec.repeat ? " Repeatable." : "";
    return `| \`${left}\` | ${spec.description}.${repeat} |`;
  });
  return ["| Flag | What it does |", "| --- | --- |", ...rows].join("\n") + "\n";
}

export function COMMAND_REFERENCE(): string {
  const parts: string[] = [
    "Every command takes `--help`. Flags always come after the command:",
    "`screencast-axi <command> [args] [flags]`. An unknown flag is a usage error rather than",
    "something quietly ignored.",
    "",
  ];
  for (const entry of COMMANDS) {
    parts.push(`#### \`${entry.command}\``);
    parts.push("");
    parts.push(`${entry.summary}.`);
    parts.push("");
    parts.push("```sh");
    parts.push(entry.usage);
    parts.push("```");
    parts.push("");
    parts.push(renderFlags(entry.flags));
  }
  return parts.join("\n").trimEnd();
}
