import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { tryGetOrgId } from "../../lobu/stores/org-context.js";

const logger = createLogger("agent-metadata-store");

/**
 * Agent metadata - user-facing info about an agent
 */
export interface AgentMetadata {
  agentId: string;
  /** User-friendly name (e.g., "Work Agent", "Personal Assistant") */
  name: string;
  description?: string;
  owner: {
    platform: string;
    userId: string;
  };
  /** Whether this is the workspace default agent */
  isWorkspaceAgent?: boolean;
  /** Workspace/team ID for workspace agents */
  workspaceId?: string;
  /** Connection that auto-created this agent (makes it a "sandbox") */
  parentConnectionId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

function rowToMetadata(row: Record<string, any>): AgentMetadata {
  return {
    agentId: row.id,
    name: row.name,
    description: row.description ?? undefined,
    owner: {
      platform: row.owner_platform ?? "owletto",
      userId: row.owner_user_id ?? "",
    },
    isWorkspaceAgent: row.is_workspace_agent ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    parentConnectionId: row.parent_connection_id ?? undefined,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : (row.created_at ?? Date.now()),
    lastUsedAt:
      row.last_used_at instanceof Date
        ? row.last_used_at.getTime()
        : (row.last_used_at ?? undefined),
  };
}

async function loadMetadataFromPg(agentId: string): Promise<AgentMetadata | null> {
  const sql = getDb();
  const orgId = tryGetOrgId();
  const rows = orgId
    ? await sql`
        SELECT id, name, description, owner_platform, owner_user_id,
               is_workspace_agent, workspace_id, parent_connection_id,
               created_at, last_used_at
        FROM agents
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `
    : await sql`
        SELECT id, name, description, owner_platform, owner_user_id,
               is_workspace_agent, workspace_id, parent_connection_id,
               created_at, last_used_at
        FROM agents
        WHERE id = ${agentId}
      `;
  if (rows.length === 0) return null;
  return rowToMetadata(rows[0]);
}

/**
 * Store agent metadata directly in `public.agents`. Read-through to PG —
 * agents reads sit at ~7 SELECTs per chat dispatch, well within PG capacity.
 */
export class AgentMetadataStore {
  /**
   * Create a new agent with metadata. Inserts into `public.agents`. If the
   * agent already exists, the listed columns are overwritten.
   */
  async createAgent(
    agentId: string,
    name: string,
    platform: string,
    userId: string,
    options?: {
      description?: string;
      isWorkspaceAgent?: boolean;
      workspaceId?: string;
      parentConnectionId?: string;
    }
  ): Promise<AgentMetadata> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    if (!orgId) {
      throw new Error(
        "AgentMetadataStore.createAgent requires an org context (use withOrgContext)"
      );
    }
    const now = new Date();
    const rows = await sql`
      INSERT INTO agents (id, organization_id, name, description, owner_platform, owner_user_id,
                          is_workspace_agent, workspace_id, parent_connection_id, created_at)
      VALUES (
        ${agentId}, ${orgId}, ${name}, ${options?.description ?? null},
        ${platform}, ${userId},
        ${options?.isWorkspaceAgent ?? false}, ${options?.workspaceId ?? null},
        ${options?.parentConnectionId ?? null}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        owner_platform = EXCLUDED.owner_platform,
        owner_user_id = EXCLUDED.owner_user_id,
        is_workspace_agent = EXCLUDED.is_workspace_agent,
        workspace_id = EXCLUDED.workspace_id,
        parent_connection_id = EXCLUDED.parent_connection_id,
        updated_at = ${now}
      WHERE agents.organization_id = EXCLUDED.organization_id
      RETURNING organization_id
    `;
    if (rows.length === 0) {
      throw new Error(`Agent '${agentId}' already exists in another organization.`);
    }

    logger.info(`Created agent metadata for ${agentId}: "${name}"`);

    return {
      agentId,
      name,
      description: options?.description,
      owner: { platform, userId },
      isWorkspaceAgent: options?.isWorkspaceAgent,
      workspaceId: options?.workspaceId,
      parentConnectionId: options?.parentConnectionId,
      createdAt: now.getTime(),
    };
  }

  async getMetadata(agentId: string): Promise<AgentMetadata | null> {
    return loadMetadataFromPg(agentId);
  }

  /**
   * Update agent metadata (partial update). Only `name`, `description`, and
   * `lastUsedAt` are accepted.
   */
  async updateMetadata(
    agentId: string,
    updates: Partial<Pick<AgentMetadata, "name" | "description" | "lastUsedAt">>
  ): Promise<void> {
    const existing = await loadMetadataFromPg(agentId);
    if (!existing) {
      logger.warn(`Cannot update metadata: agent ${agentId} not found`);
      return;
    }

    const sql = getDb();
    const orgId = tryGetOrgId();
    const merged = { ...existing, ...updates };
    const lastUsedAt =
      merged.lastUsedAt !== undefined ? new Date(merged.lastUsedAt) : null;
    const now = new Date();

    if (orgId) {
      await sql`
        UPDATE agents SET
          name = ${merged.name},
          description = ${merged.description ?? null},
          last_used_at = ${lastUsedAt},
          updated_at = ${now}
        WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
    } else {
      await sql`
        UPDATE agents SET
          name = ${merged.name},
          description = ${merged.description ?? null},
          last_used_at = ${lastUsedAt},
          updated_at = ${now}
        WHERE id = ${agentId}
      `;
    }

    logger.info(`Updated metadata for agent ${agentId}`);
  }

  /**
   * Delete agent metadata. Removes the row from `public.agents`; cascading
   * FK constraints clean up dependent rows (channel bindings, grants, etc.).
   */
  async deleteAgent(agentId: string): Promise<void> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    if (orgId) {
      await sql`
        DELETE FROM agents WHERE id = ${agentId} AND organization_id = ${orgId}
      `;
    } else {
      await sql`DELETE FROM agents WHERE id = ${agentId}`;
    }
    logger.info(`Deleted metadata for agent ${agentId}`);
  }

  async hasAgent(agentId: string): Promise<boolean> {
    const metadata = await this.getMetadata(agentId);
    return metadata !== null;
  }

  /**
   * List sandbox agents belonging to a connection.
   * Resolves the connection's parent_agent_id and returns sandboxes that
   * reference it as their `parent_connection_id`.
   */
  async listSandboxes(connectionId: string): Promise<AgentMetadata[]> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    const rows = orgId
      ? await sql`
          SELECT id, name, description, owner_platform, owner_user_id,
                 is_workspace_agent, workspace_id, parent_connection_id,
                 created_at, last_used_at
          FROM agents
          WHERE organization_id = ${orgId} AND parent_connection_id = ${connectionId}
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
        `
      : await sql`
          SELECT id, name, description, owner_platform, owner_user_id,
                 is_workspace_agent, workspace_id, parent_connection_id,
                 created_at, last_used_at
          FROM agents
          WHERE parent_connection_id = ${connectionId}
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
        `;
    return rows.map(rowToMetadata);
  }

  async listAllAgents(): Promise<AgentMetadata[]> {
    const sql = getDb();
    const orgId = tryGetOrgId();
    const rows = orgId
      ? await sql`
          SELECT id, name, description, owner_platform, owner_user_id,
                 is_workspace_agent, workspace_id, parent_connection_id,
                 created_at, last_used_at
          FROM agents
          WHERE organization_id = ${orgId}
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
        `
      : await sql`
          SELECT id, name, description, owner_platform, owner_user_id,
                 is_workspace_agent, workspace_id, parent_connection_id,
                 created_at, last_used_at
          FROM agents
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC
        `;
    return rows.map(rowToMetadata);
  }

}
