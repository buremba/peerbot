import { createLogger } from "@lobu/core";
import { getDb, tsTime } from "../../db/client.js";
import { requireOrgId, resolveOrgId } from "../../lobu/stores/org-context.js";
import {
  resolveStreamingChannelFeedId,
  softDeleteStreamingChannelFeed,
} from "./channel-feed.js";

const logger = createLogger("channel-binding-service");

/**
 * Channel binding - links a platform channel to a specific agent.
 *
 * Backed by `public.agent_channel_bindings`; only the columns that exist on
 * that table are persisted today (`platform`, `channel_id`, `team_id`,
 * `agent_id`, `created_at`).
 */
interface ChannelBinding {
  platform: string;
  channelId: string;
  agentId: string;
  teamId?: string;
  /** Org that owns this binding. Preview messages arrive on a connection in a
   * different org, so the caller needs the binding's own org to route. */
  organizationId?: string;
  /** Connection this binding routes through (the unified `connections.id`).
   * Set once the binding is linked; used to materialize / soft-delete the
   * channel's streaming feed. */
  connectionId?: string;
  createdAt: number;
}

function rowToBinding(row: Record<string, any>): ChannelBinding {
  return {
    platform: row.platform,
    channelId: row.channel_id,
    teamId: row.team_id ?? undefined,
    agentId: row.agent_id,
    organizationId: row.organization_id ?? undefined,
    connectionId: row.connection_id != null ? String(row.connection_id) : undefined,
    createdAt:
      tsTime(row.created_at),
  };
}

/**
 * Service for managing channel-to-agent bindings, backed by Postgres.
 * Read-through to PG.
 */
export class ChannelBindingService {
  async getBinding(
    platform: string,
    channelId: string,
    teamId?: string,
    organizationId?: string
  ): Promise<ChannelBinding | null> {
    const sql = getDb();
    const orgId = resolveOrgId(organizationId);
    const rows = teamId
      ? orgId
        ? await sql`
            SELECT * FROM agent_channel_bindings
            WHERE organization_id = ${orgId}
              AND platform = ${platform}
              AND channel_id = ${channelId}
              AND team_id = ${teamId}
          `
        : await sql`
            SELECT * FROM agent_channel_bindings
            WHERE platform = ${platform}
              AND channel_id = ${channelId}
              AND team_id = ${teamId}
          `
      : orgId
        ? await sql`
            SELECT * FROM agent_channel_bindings
            WHERE organization_id = ${orgId}
              AND platform = ${platform}
              AND channel_id = ${channelId}
              AND team_id IS NULL
          `
        : await sql`
            SELECT * FROM agent_channel_bindings
            WHERE platform = ${platform}
              AND channel_id = ${channelId}
              AND team_id IS NULL
          `;
    if (rows.length === 0) return null;
    return rowToBinding(rows[0]);
  }

  /**
   * Resolve a binding by its physical channel WITHOUT scoping to a caller org.
   *
   * The hosted preview bot is one connection (in its own org) that fans out to
   * agents across MANY orgs — a `/lobu link <code>` writes the binding under the
   * claim's org, not the connection's. The normal org-scoped {@link getBinding}
   * would never find it. A physical Slack channel is unique per workspace, so
   * `(platform, channel_id, team_id)` identifies exactly one place; we return
   * the most recent binding (and its org) for it. Use ONLY for previewMode
   * connections — for normal bots, org-scoping is the multi-tenant guardrail.
   */
  async getBindingAnyOrg(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<ChannelBinding | null> {
    const sql = getDb();
    const rows = teamId
      ? await sql`
          SELECT * FROM agent_channel_bindings
          WHERE platform = ${platform}
            AND channel_id = ${channelId}
            AND team_id = ${teamId}
          ORDER BY created_at DESC
          LIMIT 1
        `
      : await sql`
          SELECT * FROM agent_channel_bindings
          WHERE platform = ${platform}
            AND channel_id = ${channelId}
            AND team_id IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        `;
    if (rows.length === 0) return null;
    return rowToBinding(rows[0]);
  }

  async createBinding(
    agentId: string,
    platform: string,
    channelId: string,
    teamId?: string,
    options?: { configuredBy?: string; wasAdmin?: boolean; organizationId?: string }
  ): Promise<void> {
    const sql = getDb();
    const orgId = requireOrgId(
      options?.organizationId,
      "ChannelBindingService.createBinding",
    );
    // The upsert RETURNs the final linked connection_id (its own resolved value,
    // or a pre-existing link kept via COALESCE) so we can materialize the
    // channel's streaming feed against the SAME connection the binding routes
    // through — no second resolve that could diverge.
    let linkedConnectionId: string | null = null;
    if (teamId) {
      // The (organization_id, platform, channel_id, team_id) UNIQUE covers the
      // team-id-set case. The key is org-scoped so a sibling tenant binding the
      // same platform+channel can never collide with — and silently take over —
      // this org's row. `organization_id` is intentionally NOT in the SET list:
      // a binding must never change owners.
      //
      // Link `connection_id` to the active chat connection for this (org,
      // platform, team) at bind time (mirrors the connections-unify backfill's
      // Step 3, but at runtime so it works for installs created after the
      // one-shot migration). This is the ONLY thing that makes a MANAGED Slack
      // install (slackinst- slug, connection agent_id NULL) resolve its channels
      // in `resolveBoundChannelRows` branch (A): the tuple fallback joins on
      // `b.agent_id = ac.agent_id`, which can never match a NULL connection
      // agent_id, so without this link a managed install's transcript is an
      // unrecallable orphan. COALESCE on conflict keeps an existing link if the
      // connection isn't resolvable yet (binding created before the install row).
      const rows = await sql`
        INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, connection_id, created_at)
        VALUES (
          ${orgId}, ${agentId}, ${platform}, ${channelId}, ${teamId},
          (
            SELECT c.id FROM connections c
            WHERE c.deleted_at IS NULL
              AND c.status = 'active'
              AND c.credential_mode IS NOT NULL
              AND c.organization_id = ${orgId}
              AND c.connector_key = ${platform}
              AND c.external_tenant_id = ${teamId}
            ORDER BY c.updated_at DESC
            LIMIT 1
          ),
          now()
        )
        ON CONFLICT (organization_id, platform, channel_id, team_id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id,
          connection_id = COALESCE(EXCLUDED.connection_id, agent_channel_bindings.connection_id),
          created_at = EXCLUDED.created_at
        RETURNING connection_id
      `;
      linkedConnectionId =
        rows[0]?.connection_id != null ? String(rows[0].connection_id) : null;
    } else {
      // For team_id IS NULL the unique constraint above doesn't fire (PG
      // treats NULL as distinct). The companion org-scoped partial unique index
      // (agent_channel_bindings_org_no_team_unique) is what we conflict on.
      // Tenantless (Telegram, etc.) bindings link to the active chat connection
      // owned by this agent (mirrors the backfill's tenantless match).
      const rows = await sql`
        INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, connection_id, created_at)
        VALUES (
          ${orgId}, ${agentId}, ${platform}, ${channelId}, NULL,
          (
            SELECT c.id FROM connections c
            WHERE c.deleted_at IS NULL
              AND c.status = 'active'
              AND c.credential_mode IS NOT NULL
              AND c.organization_id = ${orgId}
              AND c.connector_key = ${platform}
              AND c.external_tenant_id IS NULL
              AND c.agent_id = ${agentId}
            ORDER BY c.updated_at DESC
            LIMIT 1
          ),
          now()
        )
        ON CONFLICT (organization_id, platform, channel_id)
          WHERE team_id IS NULL
          DO UPDATE SET agent_id = EXCLUDED.agent_id,
            connection_id = COALESCE(EXCLUDED.connection_id, agent_channel_bindings.connection_id),
            created_at = EXCLUDED.created_at
        RETURNING connection_id
      `;
      linkedConnectionId =
        rows[0]?.connection_id != null ? String(rows[0].connection_id) : null;
    }
    logger.info(`Created binding: ${platform}/${channelId} → ${agentId}`);

    // Materialize the channel as a streaming feed under its connection, so it
    // surfaces in the unified Feeds list instead of a bespoke channel island.
    // Best-effort: a feed-materialize failure must never fail the bind (recall
    // is driven by the binding, not the feed). When the connection isn't linked
    // yet (binding created before its managed install row), skip — the next
    // bind that resolves the link materializes it idempotently.
    if (linkedConnectionId) {
      await resolveStreamingChannelFeedId({
        connectionId: linkedConnectionId,
        organizationId: orgId,
        channelKey: channelId,
      });
    }
  }

  async deleteBinding(
    agentId: string,
    platform: string,
    channelId: string,
    teamId?: string,
    organizationId?: string
  ): Promise<boolean> {
    const sql = getDb();
    const orgId = resolveOrgId(organizationId);
    const existing = await this.getBinding(platform, channelId, teamId, orgId ?? undefined);
    if (!existing) {
      logger.warn(`No binding found for ${platform}/${channelId}`);
      return false;
    }
    if (existing.agentId !== agentId) {
      logger.warn(
        `Binding for ${platform}/${channelId} belongs to ${existing.agentId}, not ${agentId}`
      );
      return false;
    }

    if (teamId) {
      if (orgId) {
        await sql`
          DELETE FROM agent_channel_bindings
          WHERE organization_id = ${orgId}
            AND platform = ${platform} AND channel_id = ${channelId} AND team_id = ${teamId}
        `;
      } else {
        await sql`
          DELETE FROM agent_channel_bindings
          WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id = ${teamId}
        `;
      }
    } else {
      if (orgId) {
        await sql`
          DELETE FROM agent_channel_bindings
          WHERE organization_id = ${orgId}
            AND platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
        `;
      } else {
        await sql`
          DELETE FROM agent_channel_bindings
          WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
        `;
      }
    }
    logger.info(`Deleted binding: ${platform}/${channelId} from ${agentId}`);

    // The channel is no longer bound, so its streaming feed is retired
    // (soft-delete). Best-effort: the binding (the routing contract) is already
    // gone; a lingering feed row is cosmetic and never blocks the unbind. Keyed
    // by the connection the binding routed through + the channel id (= feed_key).
    if (existing.connectionId) {
      await softDeleteStreamingChannelFeed({
        connectionId: existing.connectionId,
        channelKey: channelId,
      });
    }
    return true;
  }

  async listBindings(
    agentId: string,
    organizationId?: string
  ): Promise<ChannelBinding[]> {
    const sql = getDb();
    const orgId = resolveOrgId(organizationId);
    const rows = orgId
      ? await sql`
          SELECT * FROM agent_channel_bindings
          WHERE agent_id = ${agentId} AND organization_id = ${orgId}
        `
      : await sql`
          SELECT * FROM agent_channel_bindings WHERE agent_id = ${agentId}
        `;
    return rows.map(rowToBinding);
  }

  async deleteAllBindings(
    agentId: string,
    organizationId?: string
  ): Promise<number> {
    const sql = getDb();
    const orgId = resolveOrgId(organizationId);
    const rows = orgId
      ? await sql`
          DELETE FROM agent_channel_bindings
          WHERE agent_id = ${agentId} AND organization_id = ${orgId}
          RETURNING platform, channel_id, team_id, connection_id
        `
      : await sql`
          DELETE FROM agent_channel_bindings
          WHERE agent_id = ${agentId}
          RETURNING platform, channel_id, team_id, connection_id
        `;
    logger.info(`Deleted ${rows.length} bindings for agent ${agentId}`);
    // Each unbound channel's streaming feed is now orphaned; retire it. Same
    // best-effort contract as deleteBinding — the binding is already gone, a
    // lingering feed row never blocks the delete. Keyed by the connection the
    // binding routed through + the channel id (= feed_key).
    for (const row of rows) {
      if (row.connection_id != null) {
        await softDeleteStreamingChannelFeed({
          connectionId: String(row.connection_id),
          channelKey: row.channel_id,
        });
      }
    }
    return rows.length;
  }
}
