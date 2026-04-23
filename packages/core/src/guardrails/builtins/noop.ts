import type { Guardrail, GuardrailStage } from "../types";

/**
 * No-op guardrail — always passes. Used as a default in tests and as a
 * template for new guardrail implementations.
 */
export function createNoopGuardrail<S extends GuardrailStage>(
  stage: S,
  name = `noop-${stage}`
): Guardrail<S> {
  return {
    name,
    stage,
    async run() {
      return { tripped: false };
    },
  };
}
