import type { AgentConfigStore } from "@lobu/core";
import { getDb } from "../../../db/client.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";

interface AgentOwnershipConfig {
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: Pick<AgentConfigStore, "getMetadata">;
}

export interface AgentOwnershipResult {
  authorized: boolean;
  ownerPlatform?: string;
  ownerUserId?: string;
  /**
   * Resolved organization id for the agent the session is authorised to
   * access. agents is keyed (organization_id, id) — the SAME agent id can
   * exist in multiple orgs — so the org id must come from the
   * authorisation result, not from a later unscoped `SELECT FROM agents
   * WHERE id = ?` lookup (codex P2 on PR #865, same shape as PR #836's
   * tenant-isolation findings).
   */
  organizationId?: string;
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

/**
 * Resolve the org id for an agent the caller is verified to own.
 *
 * Filtered by `(id, owner_platform, owner_user_id)` so a different org's
 * row that happens to share an agent id cannot be returned. Falls back to
 * `id`-only when owner is unknown (admin sessions where the caller is
 * trusted globally) — caller should treat that as a best-effort pin and
 * not rely on it for tenant isolation. Returns `undefined` if no matching
 * row exists, which collapses into the existing "no snapshot found" path
 * upstream.
 */
async function resolveAuthorizedOrgId(
  agentId: string,
  ownerPlatform: string | undefined,
  ownerUserId: string | undefined
): Promise<string | undefined> {
  const sql = getDb();
  if (ownerPlatform && ownerUserId) {
    const rows = await sql<{ organization_id: string }>`
      SELECT organization_id FROM public.agents
      WHERE id = ${agentId}
        AND owner_platform = ${ownerPlatform}
        AND owner_user_id = ${ownerUserId}
      LIMIT 1
    `;
    return rows[0]?.organization_id;
  }
  // No owner-keyed filter to apply (e.g. admin session). Take the first
  // row by deterministic order. This is the only branch where a different
  // org's row could be returned — accepted because admin-level callers
  // are trusted, and the URL doesn't carry an org slug.
  const rows = await sql<{ organization_id: string }>`
    SELECT organization_id FROM public.agents
    WHERE id = ${agentId}
    ORDER BY organization_id
    LIMIT 1
  `;
  return rows[0]?.organization_id;
}

export async function verifyOwnedAgentAccess(
  session: SettingsTokenPayload,
  agentId: string,
  config: AgentOwnershipConfig
): Promise<AgentOwnershipResult> {
  if (session.isAdmin) {
    // Admin: ownership not required. Best-effort org resolution still
    // happens so downstream code paths (transcript snapshot fallback)
    // can scope their queries.
    return {
      authorized: true,
      organizationId: await resolveAuthorizedOrgId(
        agentId,
        undefined,
        undefined
      ),
    };
  }

  if (session.agentId) {
    if (session.agentId !== agentId) {
      return { authorized: false };
    }
    // The session is bound to a single agent; the agent's org is whichever
    // owner-matched row exists. The agentId match alone isn't tenant-safe
    // because agentId is per-org-unique not globally unique — fall through
    // to the same owner-keyed lookup the non-admin path uses below if the
    // session carries owner identity, otherwise admin-style best-effort.
    const lookupUserId = resolveSettingsLookupUserId(session);
    const organizationId = await resolveAuthorizedOrgId(
      agentId,
      session.platform,
      lookupUserId || undefined
    );
    return { authorized: true, organizationId };
  }

  const lookupUserId = resolveSettingsLookupUserId(session);
  if (config.userAgentsStore) {
    const owns = await config.userAgentsStore.ownsAgent(
      session.platform,
      lookupUserId,
      agentId
    );
    if (owns) {
      const organizationId = await resolveAuthorizedOrgId(
        agentId,
        session.platform,
        lookupUserId
      );
      return {
        authorized: true,
        ownerPlatform: session.platform,
        ownerUserId: lookupUserId,
        organizationId,
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

  const organizationId = await resolveAuthorizedOrgId(
    agentId,
    metadata.owner.platform,
    metadata.owner.userId
  );
  return {
    authorized: true,
    ownerPlatform: metadata.owner.platform,
    ownerUserId: metadata.owner.userId,
    organizationId,
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

/**
 * Same as `createTokenVerifier` but returns the full ownership result —
 * authorisation status PLUS the resolved organizationId. Use this when a
 * caller needs to scope subsequent queries by org (snapshot fallback,
 * stats, etc.).
 */
export function createOwnershipResolver(config: AgentOwnershipConfig) {
  return async (
    payload: SettingsTokenPayload | null,
    agentId: string
  ): Promise<AgentOwnershipResult> => {
    if (!payload) return { authorized: false };
    return verifyOwnedAgentAccess(payload, agentId, config);
  };
}
