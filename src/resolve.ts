import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Importing a consuming project's packages, not our own.
 *
 * Every optional dependency this tool reaches for - `tsx` to read TypeScript,
 * Playwright to drive a browser - belongs to the *project*, not to this
 * package. A bare `import("playwright")` resolves against this module's own
 * location, which under `npx screencast-axi` or a global install is a cache
 * directory that has none of them. The dependency is then reported missing on
 * a project that installed it and did exactly what the error message asked.
 *
 * Anchoring resolution on the working directory finds what the project
 * actually declared, and the bare specifier stays as a fallback for a
 * side-by-side install.
 */

/** A module shape a caller is willing to accept. */
type Accept<T> = (module: T) => boolean;

/**
 * Ways to load `name`, best first.
 *
 * `require` leads because it hands back the real `module.exports`. Importing
 * the file that `require.resolve` picks looks equivalent and is not: that path
 * is the package's *CommonJS* entry, and `import()` of it re-exports only the
 * names a static lexer can spot. Playwright is the case that proves it - the
 * lexer finds its internals and misses `chromium`, so the recorder decided a
 * perfectly good Playwright was not one.
 *
 * The file-URL import stays as the second rung, because `require` cannot load
 * an ESM-only package on every supported Node.
 */
function loaders<T>(name: string, cwd: string): (() => Promise<T>)[] {
  const rungs: (() => Promise<T>)[] = [];

  let fromProject: NodeJS.Require | null = null;
  try {
    // Anchored on a file path inside cwd so node walks up from the project.
    fromProject = createRequire(join(cwd, "__resolve__.js"));
  } catch {
    // No project to resolve from. The bare specifier below still applies.
  }

  if (fromProject) {
    const req = fromProject;
    rungs.push(async () => req(name) as T);
    rungs.push(async () => (await import(pathToFileURL(req.resolve(name)).href)) as T);
  }
  rungs.push(async () => (await import(name)) as T);

  return rungs;
}

/**
 * Loads `name` from the project if it has it, else from wherever we sit.
 *
 * `accept` decides whether a loaded module is the one wanted. A rung that
 * loads but has the wrong shape is skipped rather than returned, because the
 * next rung may hold the same package in a usable form.
 *
 * Returns null when nothing satisfies `accept`, so a caller can try the next
 * package name in its own list rather than unpick an exception.
 */
export async function importFromProject<T>(
  name: string,
  accept: Accept<T> = () => true,
  cwd = process.cwd(),
): Promise<T | null> {
  for (const load of loaders<T>(name, cwd)) {
    let loaded: T;
    try {
      loaded = await load();
    } catch {
      continue;
    }
    if (loaded && accept(loaded)) return loaded;
  }
  return null;
}
