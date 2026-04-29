import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { InvalidatableCache } from "../cache/invalidatable-cache.js";

const logger = createLogger("user-agents-store");

interface UserKey {
  platform: string;
  userId: string;
}

function userCacheKey(key: UserKey): string {
  return `${key.platform}:${key.userId}`;
}

async function loadUserAgents(key: UserKey): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT agent_id
    FROM agent_users
    WHERE platform = ${key.platform} AND user_id = ${key.userId}
  `;
  return rows.map((r: any) => r.agent_id as string);
}

/**
 * Track which agents belong to which users. Backed by the `public.agent_users`
 * table; reads are cached in-process and invalidated via `agent_users_changed`.
 */
export class UserAgentsStore {
  private readonly cache: InvalidatableCache<UserKey, string[]>;

  constructor() {
    this.cache = new InvalidatableCache<UserKey, string[]>({
      channel: "agent_users_changed",
      ttlMs: 30_000,
      maxEntries: 1000,
      keyToString: userCacheKey,
      loader: loadUserAgents,
    });
  }

  async addAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    const sql = getDb();
    await sql`
      INSERT INTO agent_users (agent_id, platform, user_id, created_at)
      VALUES (${agentId}, ${platform}, ${userId}, now())
      ON CONFLICT (agent_id, platform, user_id) DO NOTHING
    `;
    this.cache.invalidate({ platform, userId });
    logger.info(`Added agent ${agentId} to user ${platform}/${userId}`);
  }

  async removeAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void> {
    const sql = getDb();
    await sql`
      DELETE FROM agent_users
      WHERE agent_id = ${agentId} AND platform = ${platform} AND user_id = ${userId}
    `;
    this.cache.invalidate({ platform, userId });
    logger.info(`Removed agent ${agentId} from user ${platform}/${userId}`);
  }

  async listAgents(platform: string, userId: string): Promise<string[]> {
    return this.cache.get({ platform, userId });
  }

  async ownsAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<boolean> {
    const agents = await this.listAgents(platform, userId);
    return agents.includes(agentId);
  }

  async close(): Promise<void> {
    await this.cache.close();
  }
}
