import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The manifest: what the recorder wrote, in a form a website can read.
 *
 * Deliberately dependency-free (node builtins only) and exported on its own
 * subpath, so a site importing it at build time does not pull in Playwright or
 * a browser it has no use for.
 */

export const MANIFEST_FILENAME = "manifest.json";

export interface ManifestEntry {
  /** File stem shared by every deliverable of this clip. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** The narration, which is also the readable text of the workflow. */
  readonly steps?: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  /** ISO 8601. Doubles as the upload date in schema.org markup. */
  readonly recordedAt: string;
  /** Playback multiplier the take was recorded at. */
  readonly pace?: number;
  /** Device preset, when the take used one. */
  readonly device?: string;
  /** Extensions actually written, e.g. ["mp4","webm","webp"]. */
  readonly formats?: readonly string[];
  /**
   * Hash of the scenario source at record time.
   *
   * What makes "this clip is stale" answerable without opening the video: if
   * the scenario has changed since, the clip shows something the code no
   * longer does.
   */
  readonly sourceHash?: string;
  /**
   * Hash of the narration at record time.
   *
   * Separates the two reasons a manifest and a scenario can disagree: steps
   * that were never written down (a safe backfill) versus wording that changed
   * while the video still shows the old line (needs a reshoot). Without it
   * those look identical and a human has to judge every field.
   */
  readonly stepsHash?: string;
  readonly recorderVersion?: string;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function hashSteps(steps: readonly string[] | undefined): string {
  return hashText(JSON.stringify(steps ?? []));
}

export function manifestPath(dir: string): string {
  return dir.endsWith(".json") ? dir : join(dir, MANIFEST_FILENAME);
}

export interface ManifestProblem {
  readonly index: number;
  readonly reason: string;
}

export interface ValidationResult {
  readonly entries: ManifestEntry[];
  readonly problems: ManifestProblem[];
}

const REQUIRED_STRINGS = ["id", "title", "description", "recordedAt"] as const;
const REQUIRED_NUMBERS = ["width", "height", "durationMs"] as const;

/**
 * Validates parsed JSON into entries, keeping the good ones.
 *
 * A half-written manifest should cost you the clips it mangled, not the whole
 * page: a site that renders four good clips and falls back for a fifth is a
 * better outcome than one that throws during a build.
 */
export function validateManifest(value: unknown): ValidationResult {
  if (!Array.isArray(value)) {
    return { entries: [], problems: [{ index: -1, reason: "manifest is not an array" }] };
  }

  const entries: ManifestEntry[] = [];
  const problems: ManifestProblem[] = [];
  const seen = new Set<string>();

  value.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      problems.push({ index, reason: "entry is not an object" });
      return;
    }
    const entry = raw as Record<string, unknown>;

    for (const key of REQUIRED_STRINGS) {
      if (typeof entry[key] !== "string" || (entry[key] as string).length === 0) {
        problems.push({ index, reason: `missing or empty \`${key}\`` });
        return;
      }
    }
    for (const key of REQUIRED_NUMBERS) {
      if (typeof entry[key] !== "number" || !Number.isFinite(entry[key])) {
        problems.push({ index, reason: `\`${key}\` is not a number` });
        return;
      }
    }
    if (entry["steps"] !== undefined && !Array.isArray(entry["steps"])) {
      problems.push({ index, reason: "`steps` is not an array" });
      return;
    }

    const id = entry["id"] as string;
    if (seen.has(id)) {
      problems.push({ index, reason: `duplicate id \`${id}\`` });
      return;
    }
    seen.add(id);
    entries.push(entry as unknown as ManifestEntry);
  });

  return { entries, problems };
}

/** Reads and validates the manifest in `dir`. A missing file is not an error. */
export function readManifest(dir: string): ValidationResult {
  const file = manifestPath(dir);
  if (!existsSync(file)) return { entries: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      entries: [],
      problems: [{ index: -1, reason: `manifest is not valid JSON: ${String(error)}` }],
    };
  }
  return validateManifest(parsed);
}

/** Writes entries sorted by id, so a reshoot produces a minimal diff. */
export function writeManifest(dir: string, entries: readonly ManifestEntry[]): string {
  const file = manifestPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
  return file;
}

/** Inserts or replaces one entry, leaving the rest untouched. */
export function upsertEntry(dir: string, entry: ManifestEntry): string {
  const { entries } = readManifest(dir);
  const next = entries.filter((e) => e.id !== entry.id);
  next.push(entry);
  return writeManifest(dir, next);
}

export interface ClipFiles {
  readonly mp4: string;
  readonly webm: string;
  readonly poster: string;
  readonly gif?: string;
}

/**
 * Absolute paths to a clip's deliverables.
 *
 * The poster extension follows what was actually written, because a machine
 * without a WebP encoder produces a PNG - a consumer that assumed `.webp`
 * would link a file that is not there.
 */
export function clipFilesFor(entry: ManifestEntry, dir: string): ClipFiles {
  const formats = entry.formats ?? ["mp4", "webm", "webp"];
  const poster = formats.includes("png") ? "png" : "webp";
  return {
    mp4: join(dir, `${entry.id}.mp4`),
    webm: join(dir, `${entry.id}.webm`),
    poster: join(dir, `${entry.id}.${poster}`),
    ...(formats.includes("gif") ? { gif: join(dir, `${entry.id}.gif`) } : {}),
  };
}

/** Whether every file the entry claims is actually on disk. */
export function missingFiles(entry: ManifestEntry, dir: string): string[] {
  const files = clipFilesFor(entry, dir);
  return [files.mp4, files.webm, files.poster, ...(files.gif ? [files.gif] : [])]
    .filter((f) => !existsSync(f))
    .map((f) => basename(f));
}
