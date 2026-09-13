/**
 * The library's own error type. Zero dependencies, on purpose.
 *
 * `axi-sdk-js` is ESM-only with an `import`-only export map, so anything that
 * imports it cannot be resolved through a CJS path - which is exactly how a
 * TypeScript config file gets loaded, and how a bundler may resolve a website's
 * build-time import of `screencast-axi/manifest`.
 *
 * So the SDK stays behind the CLI boundary: everything else throws this, and
 * `cli.ts` converts it to an `AxiError` on the way out. The structure matches
 * what the SDK renders - a message, a machine-readable code and actionable
 * suggestions - so nothing is lost in the conversion.
 */
export class ScreencastError extends Error {
  readonly code: string;
  readonly suggestions: string[];

  constructor(message: string, code: string, suggestions: string[] = []) {
    super(message);
    this.name = "ScreencastError";
    this.code = code;
    this.suggestions = suggestions;
  }
}

export function isScreencastError(value: unknown): value is ScreencastError {
  return value instanceof ScreencastError;
}

/**
 * A finished report whose content is a failure.
 *
 * `check` and `doctor` answer a question rather than performing an action, and
 * their answer can be "this library is broken" - which is a full, well-formed
 * report, not an error. They returned it and exited 0, so a CI step that ran
 * either of them passed while the tool was saying eight things were wrong.
 *
 * Thrown rather than returned purely to reach the exit code: the payload is
 * rendered exactly as it would have been on the way out, so nothing about the
 * output changes except the status.
 */
export class FailingReport extends Error {
  readonly payload: Record<string, unknown>;

  constructor(payload: Record<string, unknown>) {
    super("report describes a failure");
    this.name = "FailingReport";
    this.payload = payload;
  }
}

export function isFailingReport(value: unknown): value is FailingReport {
  return value instanceof FailingReport;
}
