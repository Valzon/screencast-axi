#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "../src/version.js";

// `screencast-axi --help | head` closes the pipe early, and an unhandled EPIPE
// turns that into a stack trace. Piping output somewhere that stops reading is
// ordinary shell use, not an error worth reporting.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../src/cli.js");
  await main();
}
