import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { main, DESCRIPTION } from "../src/cli.js";
import { VERSION } from "../src/version.js";
import { createSkillMarkdown, MAX_SKILL_MARKDOWN_CHARS, SKILL_NAME } from "../src/skill.js";

/** Collects everything the CLI writes, so a test can assert on real output. */
function capture() {
  const chunks: string[] = [];
  return {
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    get text() {
      return chunks.join("");
    },
  };
}

/**
 * `runAxiCli` writes to `process.stdout` unless told otherwise, and reports
 * failure by setting `process.exitCode`. Both are process-global, so each run
 * swaps stdout for a collector and resets the exit code around the call.
 */
async function run(argv: string[]): Promise<{ text: string; exitCode: number }> {
  const out = capture();
  const realWrite = process.stdout.write.bind(process.stdout);
  const realExitCode = process.exitCode;
  process.exitCode = 0;
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    out.stdout.write(chunk);
    return true;
  };
  try {
    await main(argv);
    return { text: out.text, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = realWrite;
    process.exitCode = realExitCode;
  }
}

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });

  it("prints the bare version and exits 0", async () => {
    const { text, exitCode } = await run(["--version"]);
    expect(text).toBe(`${VERSION}\n`);
    expect(exitCode).toBe(0);
  });
});

describe("home view", () => {
  it("prints live data, not help text, at exit 0", async () => {
    const { text, exitCode } = await run([]);
    expect(exitCode).toBe(0);
    expect(text).toContain(DESCRIPTION);
    expect(text).toContain("bin:");
    // Principle 5: a definitive empty state, never a blank list.
    expect(text).toContain("0 scenarios");
    expect(text).not.toContain("usage:");
  });
});

describe("argument contract", () => {
  it("rejects a flag before the command with exit 2", async () => {
    const { text, exitCode } = await run(["--out", "dist", "record"]);
    expect(exitCode).toBe(2);
    expect(text).toContain("Flags must come after the command");
  });

  it("rejects an unknown command with exit 2", async () => {
    const { text, exitCode } = await run(["shoot"]);
    expect(exitCode).toBe(2);
    expect(text).toContain("Unknown command: shoot");
  });

  it("rejects an unknown guide topic with exit 2 and lists the real ones", async () => {
    const { text, exitCode } = await run(["guide", "nonsense"]);
    expect(exitCode).toBe(2);
    expect(text).toContain("Unknown guide topic: nonsense");
    expect(text).toContain("overview");
  });
});

describe("guide", () => {
  it("lists topics when called bare", async () => {
    const { text, exitCode } = await run(["guide"]);
    expect(exitCode).toBe(0);
    expect(text).toContain("overview");
  });

  it("prints one topic", async () => {
    const { text, exitCode } = await run(["guide", "overview"]);
    expect(exitCode).toBe(0);
    expect(text).toContain("topic: overview");
  });

  it("serves per-command help", async () => {
    const { text } = await run(["guide", "--help"]);
    expect(text).toContain("command: guide");
  });
});

describe("skill", () => {
  it("stays under the stub cap", () => {
    expect(createSkillMarkdown().length).toBeLessThanOrEqual(MAX_SKILL_MARKDOWN_CHARS);
  });

  it("matches the committed file", () => {
    const committed = readFileSync(
      new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url),
      "utf8",
    );
    expect(committed).toBe(createSkillMarkdown());
  });

  it("defers to the CLI rather than carrying instructions", () => {
    expect(createSkillMarkdown()).toContain("Current guidance lives in the CLI");
  });
});
