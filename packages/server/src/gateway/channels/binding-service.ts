import { createLogger } from "@lobu/core";
import { getDb, tsTime } from "../../db/client.js";
import { requireOrgId, resolveOrgId } from "../../lobu/stores/org-context.js";

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
  createdAt: number;
}

function rowToBinding(row: Record<string, any>): ChannelBinding {
  return {
    platform: row.platform,
    channelId: row.channel_id,
    teamId: row.team_id ?? undefined,
    agentId: row.agent_id,
    organizationId: row.organization_id ?? undefined,
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
    if (teamId) {
      // The (organization_id, platform, channel_id, team_id) UNIQUE covers the
      // team-id-set case. The key is org-scoped so a sibling tenant binding the
      // same platform+channel can never collide with — and silently take over —
      // this org's row. `organization_id` is intentionally NOT in the SET list:
      // a binding must never change owners.
      await sql`
        INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, created_at)
        VALUES (${orgId}, ${agentId}, ${platform}, ${channelId}, ${teamId}, now())
        ON CONFLICT (organization_id, platform, channel_id, team_id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id,
          created_at = EXCLUDED.created_at
      `;
    } else {
      // For team_id IS NULL the unique constraint above doesn't fire (PG
      // treats NULL as distinct). The companion org-scoped partial unique index
      // (agent_channel_bindings_org_no_team_unique) is what we conflict on.
      await sql`
        INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, created_at)
        VALUES (${orgId}, ${agentId}, ${platform}, ${channelId}, NULL, now())
        ON CONFLICT (organization_id, platform, channel_id)
          WHERE team_id IS NULL
          DO UPDATE SET agent_id = EXCLUDED.agent_id,
            created_at = EXCLUDED.created_at
      `;
    }
    logger.info(`Created binding: ${platform}/${channelId} → ${agentId}`);
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
          RETURNING platform, channel_id, team_id
        `
      : await sql`
          DELETE FROM agent_channel_bindings
          WHERE agent_id = ${agentId}
          RETURNING platform, channel_id, team_id
        `;
    logger.info(`Deleted ${rows.length} bindings for agent ${agentId}`);
    return rows.length;
  }
}
