import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { installHooks } from "../hooks.js";
import { ScreencastError } from "../errors.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import type { AxiStructuredOutput } from "../output.js";
import { detectToolchain, installHint, run } from "../toolchain.js";
import { CONFIG_BASENAMES } from "../config.js";

export const SETUP_FLAGS: FlagSpecs = {
  "browsers-only": { kind: "boolean", description: "Install Chromium and stop" },
  scope: { kind: "string", description: "For `setup hooks`: user or project", placeholder: "s" },
};

export const INIT_FLAGS: FlagSpecs = {
  out: { kind: "string", description: "Where clips should be written", placeholder: "dir" },
  url: { kind: "string", description: "Base URL for the site you record", placeholder: "url" },
  force: { kind: "boolean", description: "Overwrite an existing config" },
};

/**
 * Does what can be done safely, and names what cannot.
 *
 * Downloading a browser is expected and reversible, so it happens. Installing
 * a system package is not something this should do behind anyone's back - a
 * tool that shells out to a package manager inside an agent loop is not one
 * you want - so a missing ffmpeg is reported with the exact command instead.
 */
export async function setupCommand(args: string[]): Promise<AxiStructuredOutput> {
  const { positionals, flags } = parseFlags(args, SETUP_FLAGS);

  if (positionals[0] === "hooks") {
    return installHooks(flags["scope"] as string | undefined);
  }
  if (positionals[0]) {
    throw new ScreencastError(`Unknown setup target: ${positionals[0]}`, "VALIDATION_ERROR", [
      "`screencast-axi setup` installs the browser and checks the rest",
      "`screencast-axi setup hooks` registers the session integration",
    ]);
  }

  const done: string[] = [];
  const manual: string[] = [];

  const install = await run("npx", ["--yes", "playwright", "install", "chromium"]);
  if (install.code === 0) {
    done.push("chromium installed (or already present)");
  } else {
    manual.push("npx playwright install chromium");
  }

  if (flags["browsers-only"] !== true) {
    const toolchain = await detectToolchain();
    if (toolchain.ffmpeg) {
      done.push(`ffmpeg found at ${toolchain.ffmpeg.path}`);
    } else {
      manual.push(installHint("ffmpeg"));
    }
    if (toolchain.posterEncoder === "png") {
      manual.push(`${installHint("cwebp")}   # optional: smaller posters, and --webp`);
    }
  }

  return {
    done,
    ...(manual.length > 0 ? { "run yourself": manual } : {}),
    totals:
      manual.length === 0 ? "ready to record" : `${manual.length} thing(s) need installing by hand`,
    help:
      manual.length === 0
        ? ["`screencast-axi doctor` confirms it, `scaffold <id>` starts a scenario"]
        : [
            "These are system packages, so they are not installed for you",
            "`screencast-axi doctor` re-checks once they are in place",
          ],
  };
}

const TEMPLATE = (outDir: string, url: string) => `import { defineConfig } from "screencast-axi";

export default defineConfig({
  // Origin only. A baseUrl carrying a path is a trap: \`goto("/")\` resolves
  // against the origin and silently drops the path.
  baseUrl: ${JSON.stringify(url)},

  scenarios: ["scenarios/*.ts"],
  outDir: ${JSON.stringify(outDir)},

  viewport: { width: 1440, height: 900 },

  // Uncomment to record pages behind a login. A person then runs
  // \`screencast-axi auth login --interactive\` once, signs in in the browser
  // window that opens, and every take afterwards reuses the session.
  //
  // browser: { profileDir: ".screencast/profile" },
  // auth: profileAuth({ signedInSelector: "[data-testid=user-menu]" }),

  overlay: {
    // Page chrome that should never end up in footage.
    hideSelectors: [],
  },
});
`;

const GITIGNORE = `
# screencast-axi: raw captures, and the profile holding a real session
.screencast/
`;

export function initCommand(args: string[]): AxiStructuredOutput {
  const { flags } = parseFlags(args, INIT_FLAGS);
  const cwd = process.cwd();

  const existing = CONFIG_BASENAMES.map((n) => join(cwd, n)).find((f) => existsSync(f));
  if (existing && flags["force"] !== true) {
    throw new ScreencastError(`A config is already here: ${existing}`, "ALREADY_EXISTS", [
      "Edit it, or pass `--force` to overwrite it",
    ]);
  }

  const outDir = (flags["out"] as string | undefined) ?? "screencasts";
  const url = (flags["url"] as string | undefined) ?? "http://localhost:3000";
  const configPath = join(cwd, "screencast.config.ts");
  writeFileSync(configPath, TEMPLATE(outDir, url));

  mkdirSync(join(cwd, "scenarios"), { recursive: true });

  // Appended rather than created: a project almost always has one already, and
  // the profile directory holds a real signed-in session.
  const gitignore = join(cwd, ".gitignore");
  let ignored = false;
  if (existsSync(gitignore)) {
    const current = readFileSync(gitignore, "utf8");
    if (!current.includes(".screencast/")) {
      appendFileSync(gitignore, GITIGNORE);
      ignored = true;
    }
  } else {
    writeFileSync(gitignore, GITIGNORE.trimStart());
    ignored = true;
  }

  return {
    created: relative(cwd, configPath),
    scenarios: relative(cwd, resolve(cwd, "scenarios")),
    ...(ignored ? { gitignored: ".screencast/" } : {}),
    help: [
      `Write your first scenario: \`screencast-axi scaffold <id> --url ${url}\``,
      "`screencast-axi doctor` checks ffmpeg and the browser are in place",
    ],
  };
}
