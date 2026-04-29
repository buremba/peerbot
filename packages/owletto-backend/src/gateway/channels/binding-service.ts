import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { InvalidatableCache } from "../cache/invalidatable-cache.js";

const logger = createLogger("channel-binding-service");

/**
 * Channel binding - links a platform channel to a specific agent.
 *
 * Backed by `public.agent_channel_bindings`; only the columns that exist on
 * that table are persisted today (`platform`, `channel_id`, `team_id`,
 * `agent_id`, `created_at`). The `configuredBy` / `configuredAt` / `wasAdmin`
 * columns from the legacy Redis layout are no longer carried — the prior
 * Postgres-backed AgentConnectionStore in `lobu/stores/postgres-stores.ts`
 * already dropped them, and no caller reads them.
 */
export interface ChannelBinding {
  platform: string;
  channelId: string;
  agentId: string;
  teamId?: string;
  createdAt: number;
}

interface BindingKey {
  platform: string;
  channelId: string;
  teamId?: string;
}

function bindingCacheKey(key: BindingKey): string {
  return `${key.platform}:${key.teamId ?? "-"}:${key.channelId}`;
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

async function loadBinding(key: BindingKey): Promise<ChannelBinding | null> {
  const sql = getDb();
  const rows = key.teamId
    ? await sql`
        SELECT * FROM agent_channel_bindings
        WHERE platform = ${key.platform}
          AND channel_id = ${key.channelId}
          AND team_id = ${key.teamId}
      `
    : await sql`
        SELECT * FROM agent_channel_bindings
        WHERE platform = ${key.platform}
          AND channel_id = ${key.channelId}
          AND team_id IS NULL
      `;
  if (rows.length === 0) return null;
  return rowToBinding(rows[0]);
}

/**
 * Service for managing channel-to-agent bindings, backed by Postgres.
 *
 * Reads are cached in-process and invalidated via `channel_binding_changed`
 * NOTIFY events whose payload matches `<platform>:<teamId|->:<channelId>`.
 */
export class ChannelBindingService {
  private readonly cache: InvalidatableCache<BindingKey, ChannelBinding | null>;

  constructor() {
    this.cache = new InvalidatableCache<BindingKey, ChannelBinding | null>({
      channel: "channel_binding_changed",
      ttlMs: 30_000,
      maxEntries: 2000,
      keyToString: bindingCacheKey,
      loader: loadBinding,
    });
  }

  async getBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<ChannelBinding | null> {
    return this.cache.get({ platform, channelId, teamId });
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
    this.cache.invalidate({ platform, channelId, teamId });
    logger.info(`Created binding: ${platform}/${channelId} → ${agentId}`);
  }

  async deleteBinding(
    agentId: string,
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<boolean> {
    const sql = getDb();
    const existing = await loadBinding({ platform, channelId, teamId });
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
    this.cache.invalidate({ platform, channelId, teamId });
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
    // RETURNING the key columns lets us invalidate every cached entry for
    // this agent immediately. Per-key NOTIFY also fires from the trigger,
    // but NOTIFY is async — we MUST drop the local cache synchronously to
    // avoid the same process serving a deleted binding right after the
    // delete returns.
    const rows = await sql`
      DELETE FROM agent_channel_bindings
      WHERE agent_id = ${agentId}
      RETURNING platform, channel_id, team_id
    `;
    for (const row of rows as Array<Record<string, any>>) {
      this.cache.invalidate({
        platform: row.platform as string,
        channelId: row.channel_id as string,
        teamId: (row.team_id as string | null) ?? undefined,
      });
    }
    logger.info(`Deleted ${rows.length} bindings for agent ${agentId}`);
    return rows.length;
  }

  async close(): Promise<void> {
    await this.cache.close();
  }
}
