import type { AxiStructuredOutput } from "./output.js";
import { ScreencastError } from "./errors.js";

/**
 * Session integration.
 *
 * The AXI convention is a setup command that registers hooks with the agent
 * harness, so the tool is ambient rather than something to remember. That is
 * not built yet, and saying so beats registering something that does nothing.
 */
export function installHooks(scope: string | undefined): AxiStructuredOutput {
  if (scope && scope !== "user" && scope !== "project") {
    throw new ScreencastError("--scope must be user or project", "VALIDATION_ERROR", [
      "Example: --scope project",
    ]);
  }
  throw new ScreencastError("Session hooks are not implemented yet", "NOT_IMPLEMENTED", [
    "Install the skill instead: `npx skills add Valzon/screencast-axi --skill screencast-axi -g`",
    "The CLI works without either - `npx -y screencast-axi --help`",
  ]);
}
