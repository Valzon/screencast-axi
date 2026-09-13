import { existsSync, readdirSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import {
  loadScenarioFiles,
  loadScenarios,
  type LoadedScenario,
  type ResolvedConfig,
} from "./config.js";
import {
  claimedFiles,
  hashSteps,
  hashText,
  missingFiles,
  readManifest,
  type ManifestEntry,
  type ManifestProblem,
} from "./manifest.js";
import { readFile } from "node:fs/promises";

/**
 * What the clip library actually contains, cross-referenced.
 *
 * Every read-only command answers some version of "what do I need to re-shoot",
 * and deriving that from scratch means reading the manifest, listing the output
 * directory and diffing both against the scenario list. Computing it once, in
 * one place, is what lets the CLI answer in a single call instead of making an
 * agent do three and guess.
 */

export type ClipStatus =
  /** Recorded, and the scenario has not changed since. */
  | "recorded"
  /** Recorded, but the scenario has changed - the clip shows something stale. */
  | "stale"
  | "never-recorded"
  /** In the manifest, but a file it claims is missing from disk. */
  | "incomplete";

export interface InventoryRow {
  readonly id: string;
  readonly status: ClipStatus;
  readonly title: string;
  readonly steps: number;
  readonly durationMs: number;
  readonly file: string;
  readonly entry?: ManifestEntry;
  /** Deliverables the manifest claims but disk does not have. */
  readonly missing: readonly string[];
  /** Why it is stale, when it is. */
  readonly staleReason?: "narration changed" | "scenario changed";
  /**
   * Whether the config lists this scenario.
   *
   * False for a clip recorded by path. It is still a real clip with a real
   * scenario behind it - it just is not part of the configured set, so
   * `record --all` will not re-shoot it.
   */
  readonly configured: boolean;
}

export interface Inventory {
  readonly rows: readonly InventoryRow[];
  /**
   * Manifest entries with no scenario behind them any more.
   *
   * Only entries whose scenario cannot be found at all: not listed by the
   * config, and either recorded before the manifest tracked source files or
   * recorded from a file that has since been moved or deleted.
   */
  readonly orphans: readonly ManifestEntry[];
  /** Media in the output directory that no manifest entry claims. */
  readonly strays: readonly string[];
  readonly problems: readonly ManifestProblem[];
  readonly counts: Readonly<Record<ClipStatus, number>>;
}

const MEDIA = new Set([".mp4", ".webm", ".webp", ".gif", ".png"]);

async function statusOf(
  loaded: LoadedScenario,
  entry: ManifestEntry | undefined,
): Promise<Pick<InventoryRow, "status" | "missing" | "staleReason">> {
  if (!entry) return { status: "never-recorded", missing: [] };

  const { scenario, file } = loaded;

  // Narration first: it is the cheaper check and the more common change, and
  // it is the one that makes a clip actively wrong rather than merely dated -
  // the caption on screen no longer matches what the scenario says.
  if (entry.stepsHash && entry.stepsHash !== hashSteps(scenario.steps)) {
    return { status: "stale", missing: [], staleReason: "narration changed" };
  }

  if (entry.sourceHash) {
    const source = await readFile(file, "utf8").catch(() => null);
    if (source !== null && hashText(source) !== entry.sourceHash) {
      return { status: "stale", missing: [], staleReason: "scenario changed" };
    }
  }

  return { status: "recorded", missing: [] };
}

/**
 * The scenario a manifest entry was recorded from, if it can still be loaded.
 *
 * A clip recorded by path (`record ./scenarios/tour.ts`) is not in the config,
 * and before the manifest tracked `sourceFile` there was no way to tell that
 * from a clip whose scenario had been deleted. Both looked like an entry
 * nothing produces - so the tool reported a clip recorded seconds earlier as
 * an orphan and offered to delete it.
 *
 * Any failure to load is answered with null rather than thrown: a read-only
 * command that surveys the library must not die because one scenario file has
 * a syntax error. The entry is then reported as an orphan, which is the
 * honest description of what can be seen from here.
 */
async function scenarioBehind(
  entry: ManifestEntry,
  outDir: string,
): Promise<LoadedScenario | null> {
  if (!entry.sourceFile) return null;
  const file = isAbsolute(entry.sourceFile) ? entry.sourceFile : resolve(outDir, entry.sourceFile);
  if (!existsSync(file)) return null;
  try {
    const loaded = await loadScenarioFiles([file]);
    return loaded.find((l) => l.scenario.id === entry.id) ?? null;
  } catch {
    return null;
  }
}

export async function buildInventory(config: ResolvedConfig): Promise<Inventory> {
  const loaded = await loadScenarios(config);
  const { entries, problems } = readManifest(config.outDir);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const configured = new Set(loaded.map((l) => l.scenario.id));

  // Clips recorded by path: real scenarios the config simply does not list.
  // Resolved here so every read-only command sees one kind of clip.
  const unlisted: LoadedScenario[] = [];
  for (const entry of entries) {
    if (configured.has(entry.id)) continue;
    const found = await scenarioBehind(entry, config.outDir);
    if (found) unlisted.push(found);
  }

  const rows: InventoryRow[] = [];
  for (const item of [...loaded, ...unlisted]) {
    const entry = byId.get(item.scenario.id);
    const state = await statusOf(item, entry);
    const missing = entry ? missingFiles(entry, config.outDir) : [];
    rows.push({
      id: item.scenario.id,
      title: item.scenario.title,
      steps: item.scenario.steps?.length ?? 0,
      durationMs: entry?.durationMs ?? 0,
      file: item.file,
      configured: configured.has(item.scenario.id),
      ...(entry ? { entry } : {}),
      ...state,
      // A missing file beats a stale hash: the clip is not merely dated, it is
      // not all there.
      ...(missing.length > 0 ? { status: "incomplete" as const, missing } : {}),
    });
  }

  const known = new Set(rows.map((r) => r.id));
  const orphans = entries.filter((e) => !known.has(e.id));

  // Built from what each entry says it wrote, so an animated WebP - which
  // shares the `.webp` extension with the poster - is not mistaken for a
  // leftover file.
  const claimed = new Set<string>();
  for (const entry of entries) for (const name of claimedFiles(entry)) claimed.add(name);
  const strays = existsSync(config.outDir)
    ? readdirSync(config.outDir)
        .filter((f) => MEDIA.has(extname(f)) && !claimed.has(basename(f)))
        .sort()
    : [];

  const counts: Record<ClipStatus, number> = {
    recorded: 0,
    stale: 0,
    "never-recorded": 0,
    incomplete: 0,
  };
  for (const row of rows) counts[row.status]++;

  return { rows, orphans, strays, problems, counts };
}

/** One-line summary, so every command phrases the same fact the same way. */
export function summarise(inventory: Inventory): string {
  const { rows, counts } = inventory;
  if (rows.length === 0) return "0 scenarios";
  const parts = [`${rows.length} scenarios`];
  for (const [state, n] of Object.entries(counts)) if (n > 0) parts.push(`${n} ${state}`);
  return parts.join(", ");
}

/** Absolute path of a clip's files, for `show`. */
export function filesOf(row: InventoryRow, outDir: string): string[] {
  if (!row.entry) return [];
  const formats = row.entry.formats ?? ["mp4", "webm", "webp"];
  return formats.map((f) => join(outDir, `${row.id}.${f}`)).filter((f) => existsSync(f));
}
