import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Turning "that file is not there" into "you meant this one".
 *
 * A missing scenario path is almost always a typo, a wrong extension or the
 * wrong directory, and the answer is usually sitting next to what was typed.
 * Naming the file that is missing is correct but leaves the reader to go and
 * look; naming the file they meant ends the detour.
 */

/** Extensions a scenario or config can have. Kept local to stay dependency-free. */
const LOADABLE = [".ts", ".mts", ".js", ".mjs"];

/**
 * Levenshtein distance, capped.
 *
 * Capped because the only question is "is this close", and an uncapped score
 * on two long unrelated names costs more than it tells you.
 */
export function distance(a: string, b: string, cap = 5): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] as number) + 1;
      const deletion = (previous[j] as number) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    // Nothing in this row is under the cap, so nothing below it can be either.
    if (Math.min(...current) > cap) return cap + 1;
    previous = current;
  }
  return previous[b.length] as number;
}

/** Every loadable file directly inside `dir`, or nothing if it is not a directory. */
export function loadableIn(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => LOADABLE.some((ext) => f.endsWith(ext)) && !f.endsWith(".d.ts"))
      .sort();
  } catch {
    return [];
  }
}

export interface NearestResult {
  /** The closest existing file, when one is close enough to be worth naming. */
  readonly suggestion?: string;
  /** What the directory actually holds, for when nothing is close. */
  readonly siblings: readonly string[];
  /** The directory those siblings are in. */
  readonly dir: string;
  /** True when the path exists but is a directory, which is its own mistake. */
  readonly isDirectory: boolean;
}

/**
 * What to say about a path that could not be loaded.
 *
 * Looks in the directory that was actually typed - a wrong directory is a
 * different mistake, and guessing across the tree would produce confident
 * nonsense.
 */
export function nearest(file: string): NearestResult {
  const isDirectory = existsSync(file) && safeIsDirectory(file);
  const dir = isDirectory ? file : dirname(file);
  const siblings = loadableIn(dir);
  const wanted = basename(file);

  let best: { name: string; score: number } | null = null;
  for (const name of siblings) {
    const score = Math.min(
      distance(wanted.toLowerCase(), name.toLowerCase()),
      // Also compare without extensions, so `tour` finds `tour.ts`.
      distance(stem(wanted).toLowerCase(), stem(name).toLowerCase()),
    );
    if (!best || score < best.score) best = { name, score };
  }

  // Close enough to name: a typo, a wrong extension, a missing plural. Beyond
  // that the guess is worse than the list.
  const threshold = Math.max(2, Math.floor(stem(wanted).length / 3));
  return {
    ...(best && best.score <= threshold ? { suggestion: join(dir, best.name) } : {}),
    siblings,
    dir,
    isDirectory,
  };
}

function stem(name: string): string {
  const ext = LOADABLE.find((e) => name.endsWith(e));
  return ext ? name.slice(0, -ext.length) : name;
}

function safeIsDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}
