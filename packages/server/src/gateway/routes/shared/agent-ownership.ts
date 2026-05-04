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

// Platforms whose user IDs come from an OAuth provider (so the session's
// `oauthUserId` is the canonical lookup key). All other platforms hand us a
// deterministic user ID directly (e.g. Telegram's claim-code flow), so
// `session.userId` is authoritative. Add an entry here if you wire up a new
// OAuth-based platform.
const OAUTH_PLATFORMS: ReadonlySet<string> = new Set();

export function resolveSettingsLookupUserId(
  session: SettingsTokenPayload
): string {
  if (session.platform === "external") {
    return session.oauthUserId || session.userId;
  }

  const isDeterministic = !OAUTH_PLATFORMS.has(session.platform);
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
