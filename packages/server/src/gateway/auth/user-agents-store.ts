import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";

const logger = createLogger("user-agents-store");

/**
 * Track which agents belong to which users. Read-through to
 * `public.agent_users`.
 */
export class UserAgentsStore {
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
    logger.info(`Removed agent ${agentId} from user ${platform}/${userId}`);
  }

  async listAgents(platform: string, userId: string): Promise<string[]> {
    const sql = getDb();
    const rows = await sql`
      SELECT agent_id
      FROM agent_users
      WHERE platform = ${platform} AND user_id = ${userId}
    `;
    return rows.map((r: any) => r.agent_id as string);
  }

  async ownsAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<boolean> {
    const agents = await this.listAgents(platform, userId);
    return agents.includes(agentId);
  }
}
