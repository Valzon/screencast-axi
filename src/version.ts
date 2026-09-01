/**
 * Leaf module: imports nothing, not even node builtins.
 *
 * `bin/screencast-axi.ts` answers `--version` from here before the command
 * graph is dynamically imported, so a version check never pays for the CLI.
 * Bumped by release-please via the annotation below, and kept in step with
 * package.json by a test - so a drift fails CI rather than shipping a CLI
 * that misreports its own version.
 */
export const VERSION = "0.1.0"; // x-release-please-version
