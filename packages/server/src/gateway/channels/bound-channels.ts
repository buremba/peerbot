/**
 * THE single source of truth for "which chat channels can this org / agent reach
 * through which connection" — including the hosted-preview cross-org case.
 *
 * Both the proactive-notification path (`resolveBotDeliveryTargets`) and the
 * native conversation tools (`resolveAddressableTargets`) resolve channels here,
 * so the cross-org preview invariant (the sharpest tenant-safety edge) lives in
 * ONE place and cannot drift between callers.
 *
 * Two branches:
 *   (A) the org's own connections, joined to their bindings on (org, agent,
 *       platform).
 *   (B) hosted-preview cross-org: a binding under THIS org served by the shared
 *       preview connection (which lives in a DIFFERENT org under a placeholder
 *       agent). A `/lobu link <code>` writes the binding under the linking org,
 *       so it never matches branch A's (org, agent) join. Gated HARD to
 *       previewMode connections with no `metadata.teamId` (the hosted-bot
 *       invariant) and NOT joined on agent_id, so a normal tenant bot is never
 *       borrowed cross-org. A NOT EXISTS skips channels the org/agent already
 *       owns via branch A (no double-resolve / double-post).
 *
 * `agentId` (optional) scopes BOTH branches to one agent — set for the
 * conversation tools (an agent may only address ITS OWN bindings), omitted for
 * org-wide notification delivery. `connectionId` (optional) narrows to a single
 * connection (used by targeted notify).
 *
 * Single-workspace assumption: with one hosted preview connection per platform
 * today, (B) matches on platform alone. When a second hosted workspace appears,
 * persist its team id and add `AND pc.settings->>'hostedWorkspaceTeamId' =
 * b.team_id` so a binding only resolves the connection installed in its
 * workspace (channel ids are workspace-scoped, not global).
 */
import type { DbClient } from "../../db/client.js";
import { runtimeConnectionIdToSlug } from "../../lobu/stores/connections-projection.js";

interface BoundChannelRow {
  /** Connection id that owns the post (preview conn for cross-org). */
  id: string;
  platform: string;
  /** As stored on the binding — may be platform-prefixed (`slack:C…`) or bare. */
  channel_id: string;
  team_id: string | null;
  created_at: Date;
}

export async function resolveBoundChannelRows(
  sql: DbClient,
  opts: {
    organizationId: string;
    agentId?: string | null;
    connectionId?: string | null;
  }
): Promise<BoundChannelRow[]> {
  const { organizationId, agentId, connectionId } = opts;
  const slugFilter = connectionId ? runtimeConnectionIdToSlug(connectionId) : null;
  // Agent scope is BINDING ownership (`b.agent_id`), NOT the connection's
  // agent_id — a managed Slack install has agent_id NULL but its bindings still
  // belong to the agent that linked them, so filtering on the connection would
  // hide managed-install channels from agent-scoped list/search/audience paths.
  const agentFilterA = agentId ? sql`AND b.agent_id = ${agentId}` : sql``;
  const agentFilterB = agentId ? sql`AND b.agent_id = ${agentId}` : sql``;
  const ownAgentFilter = agentId ? sql`AND ob.agent_id = ${agentId}` : sql``;
  const connFilterA = slugFilter ? sql`AND ac.slug = ${slugFilter}` : sql``;
  const connFilterB = slugFilter ? sql`AND pc.slug = ${slugFilter}` : sql``;

  // `connections` keys chat rows by `slug` (`agentconn-<id>` for BYO,
  // `slackinst-<id>` verbatim for managed). Callers expect the runtime
  // connection id, so strip the BYO namespace back off in SQL (mirror of
  // `slugToRuntimeConnectionId`). Folded columns: platform → `connector_key`,
  // settings/metadata → `config.{settings,chatMetadata}`, teamId →
  // `external_tenant_id`. Chat rows carry `credential_mode IS NOT NULL`.
  return (await sql`
    SELECT id, platform, channel_id, team_id, created_at FROM (
      -- (A) the org's own connections. connection_id is the sole routing key.
      SELECT
        CASE WHEN ac.slug LIKE 'agentconn-%'
          THEN substring(ac.slug from 11) ELSE ac.slug END AS id,
        ac.connector_key AS platform, b.channel_id, b.team_id, b.created_at
      FROM connections ac
      JOIN agent_channel_bindings b ON b.connection_id = ac.id
      WHERE ac.organization_id = ${organizationId}
        AND ac.status = 'active'
        AND ac.credential_mode IS NOT NULL
        AND ac.deleted_at IS NULL
        ${agentFilterA}
        ${connFilterA}

      UNION

      -- (B) hosted-preview cross-org: this org's (agent's) bindings via the
      -- shared preview connection. NO agent_id join on the preview conn; gated
      -- to previewMode + no teamId so a normal bot is never borrowed.
      SELECT
        CASE WHEN pc.slug LIKE 'agentconn-%'
          THEN substring(pc.slug from 11) ELSE pc.slug END AS id,
        pc.connector_key AS platform, b.channel_id, b.team_id, b.created_at
      FROM agent_channel_bindings b
      JOIN connections pc
        ON pc.connector_key = b.platform
       AND pc.status = 'active'
       AND pc.credential_mode IS NOT NULL
       AND pc.deleted_at IS NULL
       AND pc.config->'settings'->'previewMode' = 'true'::jsonb
       AND COALESCE(pc.external_tenant_id, pc.config->'chatMetadata'->>'teamId') IS NULL
      WHERE b.organization_id = ${organizationId}
        ${agentFilterB}
        ${connFilterB}
        -- Skip channels the org/agent already owns via branch A.
        AND NOT EXISTS (
          SELECT 1
          FROM connections own
          JOIN agent_channel_bindings ob ON ob.connection_id = own.id
          WHERE own.organization_id = ${organizationId}
            AND own.status = 'active'
            AND own.credential_mode IS NOT NULL
            AND own.deleted_at IS NULL
            ${ownAgentFilter}
            AND ob.platform = b.platform
            AND ob.channel_id = b.channel_id
        )
    ) targets
    -- Binding-creation order: the primary channel (earliest binding) first.
    ORDER BY created_at ASC
  `) as BoundChannelRow[];
}

/** Bindings store a platform-prefixed id (`slack:C…`); strip to the native id. */
export function stripPlatformPrefix(platform: string, channelId: string): string {
  const prefix = `${platform}:`;
  return channelId.startsWith(prefix)
    ? channelId.slice(prefix.length)
    : channelId;
}
