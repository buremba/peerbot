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
  const agentFilterA = agentId ? sql`AND ac.agent_id = ${agentId}` : sql``;
  const agentFilterB = agentId ? sql`AND b.agent_id = ${agentId}` : sql``;
  const ownAgentFilter = agentId ? sql`AND own.agent_id = ${agentId}` : sql``;
  const connFilterA = connectionId ? sql`AND ac.id = ${connectionId}` : sql``;
  const connFilterB = connectionId ? sql`AND pc.id = ${connectionId}` : sql``;

  return (await sql`
    SELECT id, platform, channel_id, team_id, created_at FROM (
      -- (A) the org's own connections, scoped to (org, agent, platform).
      -- KNOWN LIMITATION: not scoped by workspace/team. An agent with TWO Slack
      -- connections (two workspaces) cross-joins a channel onto both, so
      -- list_conversations can surface a duplicate handle and a post may route
      -- via the wrong workspace. A correct fix needs binding.team_id and
      -- connection.metadata->>'teamId' to be reliably co-populated, which they
      -- are NOT today (bindings carry a team id, connections often don't) — so a
      -- naive team-match join drops legitimate single-workspace bindings. Tracked
      -- as a follow-up (team_id data-model alignment), not fixed here. Single-
      -- workspace agents and non-Slack platforms are unaffected.
      SELECT ac.id, ac.platform, b.channel_id, b.team_id, b.created_at
      FROM agent_connections ac
      JOIN agent_channel_bindings b
        ON b.organization_id = ac.organization_id
       AND b.agent_id = ac.agent_id
       AND b.platform = ac.platform
      WHERE ac.organization_id = ${organizationId}
        AND ac.status = 'active'
        ${agentFilterA}
        ${connFilterA}

      UNION

      -- (B) hosted-preview cross-org: this org's (agent's) bindings via the
      -- shared preview connection. NO agent_id join on the preview conn; gated
      -- to previewMode + no metadata.teamId so a normal bot is never borrowed.
      SELECT pc.id, pc.platform, b.channel_id, b.team_id, b.created_at
      FROM agent_channel_bindings b
      JOIN agent_connections pc
        ON pc.platform = b.platform
       AND pc.status = 'active'
       AND pc.settings->'previewMode' = 'true'::jsonb
       AND (pc.metadata->>'teamId') IS NULL
      WHERE b.organization_id = ${organizationId}
        ${agentFilterB}
        ${connFilterB}
        -- Skip channels the org/agent already owns via branch A.
        AND NOT EXISTS (
          SELECT 1
          FROM agent_connections own
          JOIN agent_channel_bindings ob
            ON ob.organization_id = own.organization_id
           AND ob.agent_id = own.agent_id
           AND ob.platform = own.platform
          WHERE own.organization_id = ${organizationId}
            AND own.status = 'active'
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
