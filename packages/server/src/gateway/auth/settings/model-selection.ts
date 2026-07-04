import type { AgentSettings } from "@lobu/core";

/**
 * Reads the org's default model — the fallback tail. Injected (not imported) so
 * the resolver stays pure and DB-agnostic; the runtime passes
 * `getOrgDefaultModel` from the provider-secrets store.
 */
export type OrgDefaultModelReader = (
  organizationId: string,
) => Promise<string | null>;

/**
 * The agent-layer model ref — the middle of the layered fallback
 * `behavior → agent → org default`. Pure and synchronous: it returns the agent's
 * own `defaultModel` (a `provider/model` ref or the literal "auto"), or undefined
 * when the agent pins no model. The caller composes the tail:
 * `resolveEffectiveModelRef(settings) ?? await getOrgDefaultModel(orgId)`.
 *
 * The per-behavior override sits ABOVE this and is injected at run-enqueue into
 * `agentOptions.model` (so it wins before this is consulted).
 */
export function resolveEffectiveModelRef(
  settings: Pick<AgentSettings, "defaultModel"> | null | undefined,
): string | undefined {
  const model = settings?.defaultModel?.trim();
  return model ? model : undefined;
}

/**
 * Compose the full layered fallback for a run: the caller has already applied any
 * per-behavior override (it wins upstream, injected into the run's `model`
 * option), so this resolves `agent.defaultModel → org default`. Returns undefined
 * only when the agent pins nothing AND the org has no default — the worker then
 * surfaces its actionable "no model" error. `organizationId` may be undefined
 * (org-agnostic contexts), in which case only the agent layer is consulted.
 */
export async function composeEffectiveModelRef(
  settings: Pick<AgentSettings, "defaultModel"> | null | undefined,
  organizationId: string | undefined,
  getOrgDefaultModel: OrgDefaultModelReader,
): Promise<string | undefined> {
  const agentModel = resolveEffectiveModelRef(settings);
  if (agentModel) return agentModel;
  if (!organizationId) return undefined;
  return (await getOrgDefaultModel(organizationId)) ?? undefined;
}
