import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { tryGetOrgId } from "../../lobu/stores/org-context.js";

const logger = createLogger("user-agents-store");

/**
 * Track which agents belong to which users. Read-through to
 * `public.agent_users`.
 *
 * Methods accept an optional `organizationId` for callers outside the
 * AsyncLocalStorage org-context scope (worker spawn, OAuth callbacks).
 * Inside a request handler the ALS-backed `tryGetOrgId()` is used.
 * `addAgent` requires an explicit `organizationId` because the row is
 * an INSERT and the table requires a non-null org column.
 */
export class UserAgentsStore {
  async addAgent(
    platform: string,
    userId: string,
    agentId: string,
    organizationId?: string
  ): Promise<void> {
    const orgId = organizationId ?? tryGetOrgId();
    if (!orgId) {
      throw new Error(
        "UserAgentsStore.addAgent requires organizationId (explicit or via orgContext)"
      );
    }
    const sql = getDb();
    await sql`
      INSERT INTO agent_users (organization_id, agent_id, platform, user_id, created_at)
      VALUES (${orgId}, ${agentId}, ${platform}, ${userId}, now())
      ON CONFLICT (organization_id, agent_id, platform, user_id) DO NOTHING
    `;
    logger.info(`Added agent ${agentId} to user ${platform}/${userId}`);
  }

  async removeAgent(
    platform: string,
    userId: string,
    agentId: string,
    organizationId?: string
  ): Promise<void> {
    const sql = getDb();
    const orgId = organizationId ?? tryGetOrgId();
    if (orgId) {
      await sql`
        DELETE FROM agent_users
        WHERE organization_id = ${orgId}
          AND agent_id = ${agentId} AND platform = ${platform} AND user_id = ${userId}
      `;
    } else {
      await sql`
        DELETE FROM agent_users
        WHERE agent_id = ${agentId} AND platform = ${platform} AND user_id = ${userId}
      `;
    }
    logger.info(`Removed agent ${agentId} from user ${platform}/${userId}`);
  }

  async listAgents(
    platform: string,
    userId: string,
    organizationId?: string
  ): Promise<string[]> {
    const sql = getDb();
    const orgId = organizationId ?? tryGetOrgId();
    const rows = orgId
      ? await sql`
          SELECT agent_id
          FROM agent_users
          WHERE organization_id = ${orgId}
            AND platform = ${platform} AND user_id = ${userId}
        `
      : await sql`
          SELECT agent_id
          FROM agent_users
          WHERE platform = ${platform} AND user_id = ${userId}
        `;
    return rows.map((r: any) => r.agent_id as string);
  }

  async ownsAgent(
    platform: string,
    userId: string,
    agentId: string,
    organizationId?: string
  ): Promise<boolean> {
    const agents = await this.listAgents(platform, userId, organizationId);
    return agents.includes(agentId);
  }
}
