import { AxiError } from "axi-sdk-js";

/**
 * Spec-driven flag parsing.
 *
 * The SDK owns the shape of the invocation (`<bin> <command> ...`) but not the
 * flags inside a command, so this fills that gap with one rule: an unknown
 * flag is a usage error, never a silently dropped argument. A dropped flag is
 * worse than an error - the command appears to succeed while doing something
 * the caller did not ask for - and an agent that cannot see the mistake will
 * repeat it.
 *
 * Errors are self-correcting in one turn: they name the offending flag, the
 * nearest real one when there is a plausible match, and the full list of what
 * this command accepts, so nothing has to go and read `--help` to recover.
 */
export type FlagValue = string | number | boolean | string[];

export interface FlagSpec {
  readonly kind: "boolean" | "string" | "number";
  readonly description: string;
  /** Placeholder shown in help, e.g. `dir` renders as `--out <dir>`. */
  readonly placeholder?: string;
  /** Collect every occurrence instead of keeping the last. String flags only. */
  readonly repeat?: boolean;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue>>;
}

/**
 * Levenshtein distance, bounded by the shorter string. Used only to decide
 * whether a typo is close enough to a real flag to be worth suggesting.
 */
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const curr = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      const substitution = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (prev[j] ?? 0) + 1;
      const insertion = (curr[j - 1] ?? 0) + 1;
      curr[j] = Math.min(substitution, deletion, insertion);
    }
    prev = curr;
  }
  return prev[cols - 1] ?? Math.max(a.length, b.length);
}

/** The closest known flag to `input`, when one is close enough to mean it. */
export function nearestFlag(input: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = distance(input, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Two edits on a short flag is already a different flag, not a typo.
  return best !== null && bestDistance <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function usage(specs: FlagSpecs): string {
  const names = Object.keys(specs);
  return names.length > 0 ? `Accepts: ${names.map((n) => `--${n}`).join(", ")}` : "";
}

function unknownFlag(name: string, specs: FlagSpecs): never {
  const known = Object.keys(specs);
  const near = nearestFlag(name, known);
  const help = [
    ...(near ? [`Did you mean \`--${near}\`?`] : []),
    ...(known.length > 0 ? [usage(specs)] : ["This command accepts no flags"]),
  ];
  throw new AxiError(`Unknown flag: --${name}`, "VALIDATION_ERROR", help);
}

function numeric(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new AxiError(`--${name} expects a number, got \`${raw}\``, "VALIDATION_ERROR", [
      `Example: --${name} 30`,
    ]);
  }
  return value;
}

/**
 * Parses `args` against `specs`.
 *
 * Supports `--flag value`, `--flag=value`, `--no-flag` for booleans, and `--`
 * to stop flag parsing. Everything else is a positional.
 */
export function parseFlags(args: readonly string[], specs: FlagSpecs): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};
  let literal = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;

    if (literal || !arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }

    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    // `--no-x` turns off a boolean `x`. Only meaningful for booleans, so an
    // unknown `--no-y` still reports the flag the caller actually typed.
    if (!specs[name] && name.startsWith("no-") && specs[name.slice(3)]?.kind === "boolean") {
      flags[name.slice(3)] = false;
      continue;
    }

    const spec = specs[name];
    if (!spec) unknownFlag(name, specs);

    if (spec.kind === "boolean") {
      if (inlineValue !== null && inlineValue !== "true" && inlineValue !== "false") {
        throw new AxiError(`--${name} is a switch and takes no value`, "VALIDATION_ERROR", [
          `Pass \`--${name}\` on its own, or \`--no-${name}\` to turn it off`,
        ]);
      }
      flags[name] = inlineValue !== "false";
      continue;
    }

    const raw = inlineValue ?? args[++i];
    if (raw === undefined) {
      throw new AxiError(`--${name} expects a value`, "VALIDATION_ERROR", [
        `Pass it as \`--${name} <${spec.placeholder ?? "value"}>\``,
      ]);
    }

    if (spec.kind === "number") {
      flags[name] = numeric(name, raw);
    } else if (spec.repeat) {
      const existing = flags[name];
      flags[name] = Array.isArray(existing) ? [...existing, raw] : [raw];
    } else {
      flags[name] = raw;
    }
  }

  return { positionals, flags };
}

/** Renders a command's flags for its `--help` block. */
export function renderFlagHelp(specs: FlagSpecs): string[] {
  const entries = Object.entries(specs);
  if (entries.length === 0) return [];
  const rendered = entries.map(([name, spec]) => ({
    left: spec.kind === "boolean" ? `--${name}` : `--${name} <${spec.placeholder ?? "value"}>`,
    description: spec.description,
  }));
  const width = Math.max(...rendered.map((r) => r.left.length));
  return rendered.map((r) => `  ${r.left.padEnd(width)}  ${r.description}`);
}
