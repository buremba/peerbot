import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";

const logger = createLogger("channel-binding-service");

/**
 * Channel binding - links a platform channel to a specific agent.
 *
 * Backed by `public.agent_channel_bindings`; only the columns that exist on
 * that table are persisted today (`platform`, `channel_id`, `team_id`,
 * `agent_id`, `created_at`).
 */
export interface ChannelBinding {
  platform: string;
  channelId: string;
  agentId: string;
  teamId?: string;
  createdAt: number;
}

function rowToBinding(row: Record<string, any>): ChannelBinding {
  return {
    platform: row.platform,
    channelId: row.channel_id,
    teamId: row.team_id ?? undefined,
    agentId: row.agent_id,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : (row.created_at ?? Date.now()),
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
    teamId?: string
  ): Promise<ChannelBinding | null> {
    const sql = getDb();
    const rows = teamId
      ? await sql`
          SELECT * FROM agent_channel_bindings
          WHERE platform = ${platform}
            AND channel_id = ${channelId}
            AND team_id = ${teamId}
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

  async createBinding(
    agentId: string,
    platform: string,
    channelId: string,
    teamId?: string,
    _options?: { configuredBy?: string; wasAdmin?: boolean }
  ): Promise<void> {
    const sql = getDb();
    if (teamId) {
      // The (platform, channel_id, team_id) UNIQUE covers the team-id-set case.
      await sql`
        INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
        VALUES (${agentId}, ${platform}, ${channelId}, ${teamId}, now())
        ON CONFLICT (platform, channel_id, team_id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id
      `;
    } else {
      // For team_id IS NULL the unique constraint above doesn't fire (PG
      // treats NULL as distinct). The companion partial unique index
      // (agent_channel_bindings_no_team_unique) is what we conflict on.
      await sql`
        INSERT INTO agent_channel_bindings (agent_id, platform, channel_id, team_id, created_at)
        VALUES (${agentId}, ${platform}, ${channelId}, NULL, now())
        ON CONFLICT (platform, channel_id)
          WHERE team_id IS NULL
          DO UPDATE SET agent_id = EXCLUDED.agent_id
      `;
    }
    logger.info(`Created binding: ${platform}/${channelId} → ${agentId}`);
  }

  async deleteBinding(
    agentId: string,
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<boolean> {
    const sql = getDb();
    const existing = await this.getBinding(platform, channelId, teamId);
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
      await sql`
        DELETE FROM agent_channel_bindings
        WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id = ${teamId}
      `;
    } else {
      await sql`
        DELETE FROM agent_channel_bindings
        WHERE platform = ${platform} AND channel_id = ${channelId} AND team_id IS NULL
      `;
    }
    logger.info(`Deleted binding: ${platform}/${channelId} from ${agentId}`);
    return true;
  }

  async listBindings(agentId: string): Promise<ChannelBinding[]> {
    const sql = getDb();
    const rows = await sql`
      SELECT * FROM agent_channel_bindings WHERE agent_id = ${agentId}
    `;
    return rows.map(rowToBinding);
  }

  async deleteAllBindings(agentId: string): Promise<number> {
    const sql = getDb();
    const rows = await sql`
      DELETE FROM agent_channel_bindings
      WHERE agent_id = ${agentId}
      RETURNING platform, channel_id, team_id
    `;
    logger.info(`Deleted ${rows.length} bindings for agent ${agentId}`);
    return rows.length;
  }
}
