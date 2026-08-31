import type { AxiStructuredOutput } from "../output.js";

/**
 * The no-argument view: live data, never help text (AXI principle 8).
 *
 * The SDK prepends `{ bin, description }`, so this returns only the state.
 * With no scenarios yet it still reports a definitive empty state rather than
 * a blank list (principle 5) - "nothing recorded here" is a fact worth
 * printing, and it exits 0 because it is not a failure.
 */
export function homeView(): AxiStructuredOutput {
  return {
    config: "none",
    scenarios: [],
    totals: "0 scenarios, 0 recorded",
    help: [
      "Run `screencast-axi guide` to list the guidance topics",
      "Recording is not wired up yet - this build ships the CLI shell only",
    ],
  };
}
