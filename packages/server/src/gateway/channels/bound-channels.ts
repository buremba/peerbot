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
  const connFilterA = slugFilter
    ? sql`AND b.connection_slug = ${slugFilter}`
    : sql``;
  const connFilterB = slugFilter
    ? sql`AND b.connection_slug = ${slugFilter}`
    : sql``;

  // `connections` keys chat rows by `slug` (`agentconn-<id>` for BYO,
  // `slackinst-<id>` verbatim for managed). Callers expect the runtime
  // connection id, so strip the BYO namespace back off in SQL (mirror of
  // `slugToRuntimeConnectionId`). Folded columns: platform → `connector_key`,
  // settings/metadata → `config.{settings,chatMetadata}`, teamId →
  // `external_tenant_id`. Chat rows carry `credential_mode IS NOT NULL`.
  return (await sql`
    SELECT id, platform, channel_id, team_id, created_at FROM (
      SELECT DISTINCT ON (id, platform, channel_id)
        id, platform, channel_id, team_id, created_at
      FROM (
        -- (A) the org's own connections. connection_id is the sole routing key.
        SELECT
          b.runtime_connection_id AS id,
          b.platform, b.channel_id, b.team_id, b.created_at
        FROM behavior_message_subscriptions b
        WHERE b.connection_organization_id = ${organizationId}
          AND b.organization_id = ${organizationId}
          AND b.connection_status = 'active'
          AND b.credential_mode IS NOT NULL
          ${agentFilterA}
          ${connFilterA}

        UNION ALL

        -- (B) hosted-preview cross-org: this org's (agent's) bindings via the
        -- shared preview connection. NO agent_id join on the preview conn; gated
        -- to previewMode + no teamId so a normal bot is never borrowed.
        SELECT
          b.runtime_connection_id AS id,
          b.platform, b.channel_id, b.team_id, b.created_at
        FROM behavior_message_subscriptions b
        WHERE b.organization_id = ${organizationId}
          AND b.connection_status = 'active'
          AND b.credential_mode IS NOT NULL
          AND b.preview_mode
          AND b.connection_team_id IS NULL
          ${agentFilterB}
          ${connFilterB}
          -- Skip channels the org/agent already owns via branch A.
          AND NOT EXISTS (
            SELECT 1
            FROM behavior_message_subscriptions ob
            WHERE ob.connection_organization_id = ${organizationId}
              AND ob.organization_id = ${organizationId}
              AND ob.connection_status = 'active'
              AND ob.credential_mode IS NOT NULL
              ${ownAgentFilter}
              AND ob.platform = b.platform
              AND ob.channel_id = b.channel_id
          )
      ) candidates
      ORDER BY id, platform, channel_id, created_at ASC
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
