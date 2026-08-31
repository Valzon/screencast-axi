/**
 * Public authoring surface.
 *
 * Playwright is referenced through `import type` only, so importing this
 * module costs nothing at runtime and works in a project that has no browser
 * installed - a site reading clip metadata at build time should not have to
 * install one.
 */
export { VERSION } from "./version.js";

export { Director, type DirectorOptions } from "./director.js";
export {
  defineScenario,
  isScenario,
  type DefinedScenario,
  type Scenario,
  type ScenarioContext,
  type Target,
  type Viewport,
} from "./types.js";
export {
  DEFAULT_OVERLAY_THEME,
  resolveOverlayTheme,
  type OverlayApi,
  type OverlayTheme,
  type ResolvedOverlayTheme,
} from "./overlay.js";
export {
  DEFAULT_ENCODE_SETTINGS,
  encode,
  type EncodeOptions,
  type EncodeResult,
  type EncodeSettings,
} from "./encode.js";
export {
  detectToolchain,
  installHint,
  type BinaryInfo,
  type PosterEncoder,
  type Toolchain,
} from "./toolchain.js";
export {
  defineConfig,
  loadConfig,
  loadScenarios,
  type BrowserConfig,
  type ResolvedConfig,
  type ScreencastConfig,
} from "./config.js";
export { clipFilesFor, readManifest, type ClipFiles, type ManifestEntry } from "./manifest.js";
