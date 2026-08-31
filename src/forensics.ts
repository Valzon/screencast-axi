import type { Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * What a failed take leaves behind.
 *
 * Writing a scenario blind is the real cost of scripting rather than driving a
 * browser live: a stale selector surfaces as a bare `TimeoutError`, with no
 * page, no URL and nothing to look at, and the next attempt is another minute
 * of guessing. Capturing the page's state before the context closes turns that
 * into one sighted iteration, which is most of what a live session would have
 * bought.
 *
 * All of it is written to disk and reported as absolute paths - never inlined
 * into the output, where a screenshot would be megabytes of base64 nobody
 * asked for.
 */

export interface NearMatch {
  readonly selector: string;
  readonly count: number;
  readonly visible: boolean;
}

export interface Forensics {
  readonly url?: string;
  readonly title?: string;
  readonly screenshot?: string;
  readonly html?: string;
  readonly nearMatches?: readonly NearMatch[];
  /** Anything that went wrong while collecting the above. */
  readonly notes?: readonly string[];
}

/**
 * Selector fragments worth reporting counts for.
 *
 * A descendant selector that matches nothing tells you nothing about *which*
 * part is wrong. Its pieces do: if `.grid` matches once and `.grid .row`
 * matches zero times, the container rendered and the rows did not, which is a
 * data problem rather than a selector typo.
 */
export function selectorCandidates(selector: string): string[] {
  const trimmed = selector.trim();
  if (!trimmed || /[>~+]/.test(trimmed)) return [trimmed].filter(Boolean);

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [trimmed];

  const candidates: string[] = [];
  // Progressively shorter prefixes, then the trailing piece on its own.
  for (let i = parts.length - 1; i >= 1; i--) {
    candidates.push(parts.slice(0, i).join(" "));
  }
  const last = parts[parts.length - 1];
  if (last && !candidates.includes(last)) candidates.push(last);
  return candidates;
}

/** Pulls a CSS selector out of a Playwright timeout message, if there is one. */
export function selectorFromError(message: string): string | null {
  const patterns = [
    /waiting for locator\('([^']+)'\)/,
    /locator\('([^']+)'\)/,
    /selector "([^"]+)"/,
    /no element matched "([^"]+)"/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function probe(page: Page, selector: string): Promise<NearMatch> {
  try {
    const locator = page.locator(selector);
    const count = await locator.count();
    const visible =
      count > 0
        ? await locator
            .first()
            .isVisible()
            .catch(() => false)
        : false;
    return { selector, count, visible };
  } catch {
    return { selector, count: 0, visible: false };
  }
}

export interface CaptureOptions {
  readonly page: Page;
  readonly rawDir: string;
  readonly id: string;
  readonly error: unknown;
}

/**
 * Collects everything useful about a failure. Never throws: a problem here
 * must not replace the scenario's own error with a worse one.
 */
export async function captureFailure(options: CaptureOptions): Promise<Forensics> {
  const { page, rawDir, id, error } = options;
  const notes: string[] = [];
  const result: {
    url?: string;
    title?: string;
    screenshot?: string;
    html?: string;
    nearMatches?: NearMatch[];
  } = {};

  try {
    await mkdir(rawDir, { recursive: true });
  } catch {
    return { notes: ["could not create the scratch directory"] };
  }

  try {
    result.url = page.url();
  } catch {
    notes.push("page was already closed");
    return { ...result, notes };
  }

  try {
    result.title = await page.title();
  } catch {
    notes.push("could not read the page title");
  }

  try {
    const screenshot = join(rawDir, `${id}.failure.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
    result.screenshot = screenshot;
  } catch {
    notes.push("could not take a screenshot");
  }

  const message = error instanceof Error ? error.message : String(error);
  const selector = selectorFromError(message);
  if (selector) {
    const candidates = selectorCandidates(selector);
    const matches: NearMatch[] = [];
    for (const candidate of candidates.slice(0, 4)) {
      matches.push(await probe(page, candidate));
    }
    if (matches.length > 0) result.nearMatches = matches;
  }

  return { ...result, ...(notes.length > 0 ? { notes } : {}) };
}
