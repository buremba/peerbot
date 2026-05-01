import type { AgentConfigStore } from "@lobu/core";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import { getAuthMethod } from "../../connections/platform-auth-methods.js";

interface AgentOwnershipConfig {
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: Pick<AgentConfigStore, "getMetadata">;
}

interface AgentOwnershipResult {
  authorized: boolean;
  ownerPlatform?: string;
  ownerUserId?: string;
}

export function resolveSettingsLookupUserId(
  session: SettingsTokenPayload
): string {
  if (session.platform === "external") {
    return session.oauthUserId || session.userId;
  }

  const isDeterministic = getAuthMethod(session.platform).type !== "oauth";
  return isDeterministic
    ? session.userId
    : session.oauthUserId || session.userId;
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
