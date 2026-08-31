/**
 * Public authoring surface.
 *
 * Kept free of any runtime Playwright import - scenario types reference
 * Playwright through `import type` only, so importing this module costs
 * nothing at runtime and works in a project that has no browser installed.
 */
export { VERSION } from "./version.js";
