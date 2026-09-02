/**
 * Operator-owned target resolution for the judges.
 *
 * The judges are policy controls, so their credential is the DEPLOYMENT's, not
 * the tenant's. `resolveCompletionTarget` reads the org's `inference_providers`
 * rows, which is right for the fail-open enrichment features but wrong here: a
 * tenant who supplies the key behind the model that polices their own agent
 * controls the control. This resolver reads `config/providers.json` plus the
 * operator's environment instead, exactly like fresh-agent system-key
 * resolution does.
 *
 * A tenant may still NAME a model — a per-rule `egressConfig.judgeModel` or a
 * custom guardrail's `model`. That ref only resolves when it points at a
 * provider this deployment already holds a system key for, so the choice is
 * bounded by the operator's own installed providers. A ref naming anything else
 * resolves to null, and the judge fails closed.
 */

import { createLogger, getErrorMessage } from "@lobu/core";
import type { ProviderConfigEntry } from "@lobu/core";
import { resolveEnv } from "../auth/mcp/string-substitution.js";
import {
  ProviderRegistryService,
  resolveProviderRegistryPath,
} from "../services/provider-registry-service.js";
import {
  type GatewayCompletionTarget,
  splitModelRef,
} from "./gateway-completion.js";

const logger = createLogger("system-judge-target");

/**
 * Why a judge target could not be resolved. Both values are MISCONFIGURATION,
 * never a transient fault — the caller must fail closed without tripping the
 * circuit breaker, whose cooldown exists for upstreams that might recover.
 */
export type SystemJudgeTargetFailure =
  | "unqualified-ref"
  | "no-system-provider";

export type SystemJudgeTargetResult =
  | { ok: true; target: GatewayCompletionTarget }
  | { ok: false; reason: SystemJudgeTargetFailure; detail: string };

/**
 * Resolve `<slug>/<model>` against this deployment's system-key providers.
 *
 * Deliberately requires a QUALIFIED ref. `resolveCompletionTarget` can accept a
 * bare model id because it has an org default provider to fall back on; there
 * is no equivalent operator default, and guessing one would post the request to
 * a vendor that does not know the model. For a fail-closed control, "I cannot
 * tell which provider you meant" must be a denial, not a guess.
 */
export async function resolveSystemJudgeTarget(
  modelRef: string
): Promise<SystemJudgeTargetResult> {
  const ref = modelRef.trim();
  const parts = splitModelRef(ref);
  if (!parts) {
    return {
      ok: false,
      reason: "unqualified-ref",
      detail: `judge model "${ref}" is not a "<provider>/<model>" ref; an operator-owned judge cannot infer the provider`,
    };
  }

  let configs: Record<string, ProviderConfigEntry> = {};
  try {
    const registry = new ProviderRegistryService(resolveProviderRegistryPath());
    configs = await registry.getProviderConfigs();
  } catch (err) {
    // Unreadable registry means NO provider is verifiably operator-keyed.
    // Fail closed rather than falling through to some other credential source.
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `provider registry unreadable: ${getErrorMessage(err)}`,
    };
  }

  const config = configs[parts.slug];
  if (!config) {
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `no provider "${parts.slug}" in the provider registry`,
    };
  }

  // The system key is the whole point: an org row must never satisfy this.
  const apiKey = config.envVarName ? resolveEnv(config.envVarName) : undefined;
  if (!apiKey) {
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `provider "${parts.slug}" has no deployment credential (${config.envVarName ?? "no envVarName"} unset)`,
    };
  }

  // Same protocol gate the shared client applies. gatewayCompletion speaks
  // OpenAI-compatible /chat/completions and nothing else.
  if (config.sdkCompat !== "openai") {
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `provider "${parts.slug}" speaks "${config.sdkCompat ?? "unknown"}", not the OpenAI-compatible protocol`,
    };
  }

  const baseUrl =
    config.upstreamBaseUrl ??
    (parts.slug === "openai" ? "https://api.openai.com/v1" : undefined);
  if (!baseUrl) {
    return {
      ok: false,
      reason: "no-system-provider",
      detail: `provider "${parts.slug}" declares no upstream base URL`,
    };
  }

  logger.debug(
    { slug: parts.slug, model: parts.model },
    "resolved operator-owned judge target"
  );

  return {
    ok: true,
    target: {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      model: parts.model,
    },
  };
}
