import { access, constants, mkdir } from "node:fs/promises";
import { loadConfig, resolveConfigPath } from "../config.js";
import { parseFlags, type FlagSpecs } from "../flags.js";
import type { AxiStructuredOutput } from "../output.js";
import { detectToolchain, installHint, run } from "../toolchain.js";
import { resolvePlaywright } from "../browser.js";

export const DOCTOR_FLAGS: FlagSpecs = {
  config: { kind: "string", description: "Path to a config file", placeholder: "path" },
};

interface Finding {
  readonly what: string;
  readonly ok: boolean;
  readonly detail: string;
  /** What to run when it is not ok. */
  readonly fix?: string;
}

/**
 * Everything that has to be true before a take can run.
 *
 * The point is to answer all of it at once. A missing ffmpeg discovered
 * partway through a forty-second recording is the same information delivered
 * at the worst possible moment, and each prerequisite found one at a time is a
 * separate round trip.
 */
export async function doctorCommand(args: string[]): Promise<AxiStructuredOutput> {
  const { flags } = parseFlags(args, DOCTOR_FLAGS);
  const findings: Finding[] = [];

  findings.push({
    what: "node",
    ok: Number(process.versions.node.split(".")[0]) >= 20,
    detail: process.versions.node,
    ...(Number(process.versions.node.split(".")[0]) >= 20
      ? {}
      : { fix: "Upgrade to Node 20 or newer" }),
  });

  let playwright: string | null = null;
  try {
    const { specifier } = await resolvePlaywright();
    playwright = specifier;
    findings.push({ what: "playwright", ok: true, detail: `resolved from \`${specifier}\`` });
  } catch {
    findings.push({
      what: "playwright",
      ok: false,
      detail: "not installed",
      fix: "pnpm add -D playwright",
    });
  }

  if (playwright) {
    // Launching is the only honest check: the package can be installed while
    // the browser binary it needs has never been downloaded.
    try {
      const { module } = await resolvePlaywright();
      const browser = await module.chromium.launch();
      const version = browser.version?.() ?? "ok";
      await browser.close();
      findings.push({ what: "chromium", ok: true, detail: String(version) });
    } catch (error) {
      findings.push({
        what: "chromium",
        ok: false,
        detail: (error as Error).message.split("\n")[0] ?? "will not launch",
        fix: "screencast-axi setup",
      });
    }
  }

  const toolchain = await detectToolchain();
  findings.push({
    what: "ffmpeg",
    ok: toolchain.ffmpeg !== null,
    detail: toolchain.ffmpeg
      ? `${toolchain.ffmpeg.version.replace(/^ffmpeg version /, "").split(" ")[0]} (${toolchain.ffmpeg.source})`
      : "not found",
    ...(toolchain.ffmpeg ? {} : { fix: installHint("ffmpeg") }),
  });
  findings.push({
    what: "poster encoder",
    ok: true,
    detail:
      toolchain.posterEncoder === "png"
        ? "PNG fallback - neither ffmpeg's libwebp nor cwebp is available"
        : `WebP via ${toolchain.posterEncoder}`,
    ...(toolchain.posterEncoder === "png" ? { fix: installHint("cwebp") } : {}),
  });
  findings.push({
    what: "animated webp",
    ok: true,
    detail: toolchain.gif2webp ? "available via gif2webp" : "unavailable - `--webp` will fail",
    ...(toolchain.gif2webp ? {} : { fix: installHint("cwebp") }),
  });

  const configPath = resolveConfigPath(flags["config"] as string | undefined);
  findings.push({
    what: "config",
    ok: true,
    detail: configPath ?? "none - defaults apply, which is fine for a one-off",
  });

  if (configPath) {
    const config = await loadConfig(flags["config"] as string | undefined);
    let writable = true;
    try {
      await mkdir(config.outDir, { recursive: true });
      await access(config.outDir, constants.W_OK);
    } catch {
      writable = false;
    }
    findings.push({
      what: "output directory",
      ok: writable,
      detail: writable ? config.outDir : `${config.outDir} is not writable`,
      ...(writable ? {} : { fix: `Check permissions on ${config.outDir}` }),
    });
    findings.push({
      what: "scenarios",
      ok: true,
      detail: config.scenarios.length > 0 ? config.scenarios.join(", ") : "none configured",
    });
  }

  const broken = findings.filter((f) => !f.ok);
  const fixes = findings.filter((f) => f.fix).map((f) => `${f.what}: ${f.fix}`);

  return {
    ready: broken.length === 0,
    checks: findings.map((f) => ({
      what: f.what,
      ok: f.ok,
      detail: f.detail,
    })),
    totals:
      broken.length === 0
        ? `${findings.length} checks, all clear`
        : `${broken.length} of ${findings.length} checks need attention`,
    help:
      fixes.length > 0
        ? fixes
        : ["Everything a recording needs is in place. `screencast-axi record <id>`"],
  };
}

/** Exposed for `setup`, which needs the same probe. */
export { run };
