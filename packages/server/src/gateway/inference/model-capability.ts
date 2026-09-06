/**
 * The real context window and output ceiling of the model a turn will run.
 *
 * The isolate lane used to hand pi a hardcoded `contextWindow: 200_000` and an
 * `8192` default, on the reasoning that one turn never compacts. Once the turn
 * carries real history that stopped being a bookkeeping field: a window that is
 * too large silently overflows the upstream, and one that is too small throws
 * away context the model could have had. Neither failure is visible in the
 * transcript, so both must be resolved rather than guessed.
 *
 * The source of truth is pi-ai's own model registry — the SAME `getModel` the
 * subprocess lane's `model-resolver.ts` reads, so a model's window means one
 * thing on both lanes. A model the registry does not carry (an org's BYO
 * provider, a brand-new id) falls back to the conservative pair
 * `buildDynamicOpenAIModel` already uses for exactly that case, which is a
 * documented floor rather than an optimistic guess: under-reading a window
 * costs some history, over-reading it costs the whole turn.
 */

import { getModel } from "@mariozechner/pi-ai";

export interface ModelCapability {
  contextWindow: number;
  maxTokens: number;
  /** False when the registry had no entry and the floor below was used. */
  fromRegistry: boolean;
}

/**
 * The floor for a model pi-ai has never heard of. Same numbers as
 * `buildDynamicOpenAIModel` in the subprocess lane's model-resolver, so an
 * unknown model is budgeted identically whichever lane runs it.
 */
export const UNKNOWN_MODEL_CAPABILITY: ModelCapability = {
  contextWindow: 128_000,
  maxTokens: 16_384,
  fromRegistry: false,
};

/**
 * Look the model up by the provider name pi-ai registers it under (the
 * `registryAlias` the producer already resolves for the wire's `provider`
 * field) and its bare model id.
 *
 * `getModel` is a two-level Map lookup that answers `undefined` for an unknown
 * provider or id, so a miss is a normal outcome and never throws.
 */
export function resolveModelCapability(
  registryProvider: string,
  modelId: string
): ModelCapability {
  const model = getModel(registryProvider as never, modelId as never) as
    | { contextWindow?: number; maxTokens?: number }
    | undefined;
  const contextWindow = model?.contextWindow;
  const maxTokens = model?.maxTokens;
  // A registry entry missing either number is treated as a miss for that
  // number alone: partial data is still better than the floor for the half it
  // does carry, and worse than nothing if trusted where it is absent.
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return UNKNOWN_MODEL_CAPABILITY;
  }
  return {
    contextWindow,
    maxTokens:
      typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
        ? maxTokens
        : UNKNOWN_MODEL_CAPABILITY.maxTokens,
    fromRegistry: true,
  };
}
