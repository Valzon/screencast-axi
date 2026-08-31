/**
 * Structural mirror of the SDK's `AxiRenderable`.
 *
 * `axi-sdk-js` does not export its `output` module, so the renderable type is
 * restated here rather than reached for through a deep import.
 */
export type AxiStructuredOutput = Record<string, unknown>;
export type AxiRenderable = string | AxiStructuredOutput;
