/**
 * Leaf module: imports nothing, not even node builtins.
 *
 * `bin/screencast-axi.ts` answers `--version` from here before the command
 * graph is dynamically imported, so a version check never pays for the CLI.
 * Kept in sync with package.json by `test/version.test.ts`.
 */
export const VERSION = "0.0.0";
