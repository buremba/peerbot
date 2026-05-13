import type { AgentConfigStore } from "@lobu/core";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";

interface AgentOwnershipConfig {
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: Pick<AgentConfigStore, "getMetadata">;
}

interface AgentOwnershipResult {
  authorized: boolean;
  ownerPlatform?: string;
  ownerUserId?: string;
}

// `external` sessions carry an OAuth-provider user ID, so prefer that as the
// canonical lookup key; every other platform hands us a deterministic user ID
// directly (e.g. Telegram's claim-code flow), so `session.userId` is
// authoritative.
export function resolveSettingsLookupUserId(
  session: SettingsTokenPayload
): string {
  return session.platform === "external"
    ? session.oauthUserId || session.userId
    : session.userId;
}

function sessionMatchesMetadataOwner(
  session: SettingsTokenPayload,
  ownerPlatform: string,
  ownerUserId: string
): boolean {
  const lookupUserId = resolveSettingsLookupUserId(session);
  if (!lookupUserId || ownerUserId !== lookupUserId) {
    return false;
  }

  return ownerPlatform === session.platform || session.platform === "external";
}

export async function verifyOwnedAgentAccess(
  session: SettingsTokenPayload,
  agentId: string,
  config: AgentOwnershipConfig
): Promise<AgentOwnershipResult> {
  if (session.isAdmin) {
    return { authorized: true };
  }

  if (session.agentId) {
    return { authorized: session.agentId === agentId };
  }

  const lookupUserId = resolveSettingsLookupUserId(session);
  if (config.userAgentsStore) {
    const owns = await config.userAgentsStore.ownsAgent(
      session.platform,
      lookupUserId,
      agentId
    );
    if (owns) {
      return {
        authorized: true,
        ownerPlatform: session.platform,
        ownerUserId: lookupUserId,
      };
    }
  }

  if (!config.agentMetadataStore) {
    return { authorized: false };
  }

  const metadata = await config.agentMetadataStore.getMetadata(agentId);
  if (
    !metadata?.owner ||
    !sessionMatchesMetadataOwner(
      session,
      metadata.owner.platform,
      metadata.owner.userId
    )
  ) {
    return { authorized: false };
  }

  if (config.userAgentsStore) {
    config.userAgentsStore
      .addAgent(session.platform, lookupUserId, agentId)
      .catch(() => {
        /* best-effort reconciliation */
      });
  }

  return {
    authorized: true,
    ownerPlatform: metadata.owner.platform,
    ownerUserId: metadata.owner.userId,
  };
}

/**
 * Create a token verifier function scoped to a given config.
 *
 * The returned async function accepts a decoded settings token payload and an
 * agentId, then returns the payload if the caller is authorised, or null.
 */
export function createTokenVerifier(config: AgentOwnershipConfig) {
  return async (
    payload: SettingsTokenPayload | null,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    if (!payload) return null;
    const result = await verifyOwnedAgentAccess(payload, agentId, config);
    return result.authorized ? payload : null;
  };
}
