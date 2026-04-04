/**
 * Shared token verification utility for public routes.
 *
 * Verifies a settings token against an agentId by checking direct agentId match,
 * user ownership via UserAgentsStore, or canonical metadata owner fallback.
 */

import type { AgentConfigStore } from "@lobu/core";
import type { SettingsTokenPayload } from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import { verifyOwnedAgentAccess } from "./agent-ownership";

export interface TokenVerifierConfig {
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: Pick<AgentConfigStore, "getMetadata">;
}

/**
 * Create a token verifier function scoped to a given config.
 *
 * The returned async function accepts a decoded settings token payload and an
 * agentId, then returns the payload if the caller is authorised, or null.
 */
export function createTokenVerifier(config: TokenVerifierConfig) {
  return async (
    payload: SettingsTokenPayload | null,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    if (!payload) return null;

    const result = await verifyOwnedAgentAccess(payload, agentId, config);
    return result.authorized ? payload : null;
  };
}
