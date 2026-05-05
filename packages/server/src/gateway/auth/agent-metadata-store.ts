import {
  type AgentConfigStore,
  type AgentMetadata,
  createLogger,
} from "@lobu/core";

// Re-export so existing imports from this module keep working.
export type { AgentMetadata };

const logger = createLogger("agent-metadata-store");

/**
 * User-facing metadata reader/writer.
 *
 * Thin overlay over the host's `AgentConfigStore`. Exists to keep the
 * `createAgent(agentId, name, platform, userId, options)` ergonomic for
 * route handlers — `configStore.saveMetadata` takes a fully-formed
 * `AgentMetadata` object instead.
 */
export class AgentMetadataStore {
  constructor(private readonly configStore: AgentConfigStore) {}

  /**
   * Create a new agent with metadata. Throws if an agent with the same id
   * already exists in a different organization (the underlying store enforces
   * the cross-org guard via `WHERE agents.organization_id = EXCLUDED.organization_id`).
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
    }
  ): Promise<AgentMetadata> {
    const metadata: AgentMetadata = {
      agentId,
      name,
      description: options?.description,
      owner: { platform, userId },
      isWorkspaceAgent: options?.isWorkspaceAgent,
      workspaceId: options?.workspaceId,
      createdAt: Date.now(),
    };
    await this.configStore.saveMetadata(agentId, metadata);
    logger.info(`Created agent metadata for ${agentId}: "${name}"`);
    return metadata;
  }

  async getMetadata(agentId: string): Promise<AgentMetadata | null> {
    return this.configStore.getMetadata(agentId);
  }

  /**
   * Update agent metadata (partial update). Only `name`, `description`, and
   * `lastUsedAt` are accepted.
   */
  async updateMetadata(
    agentId: string,
    updates: Partial<Pick<AgentMetadata, "name" | "description" | "lastUsedAt">>
  ): Promise<void> {
    await this.configStore.updateMetadata(agentId, updates);
    logger.info(`Updated metadata for agent ${agentId}`);
  }

  /**
   * Delete agent metadata. The underlying delete cascades to dependent rows
   * (channel bindings, grants, etc.) via FK constraints.
   */
  async deleteAgent(agentId: string): Promise<void> {
    await this.configStore.deleteMetadata(agentId);
    logger.info(`Deleted metadata for agent ${agentId}`);
  }

  async hasAgent(agentId: string): Promise<boolean> {
    return this.configStore.hasAgent(agentId);
  }

  async listAllAgents(): Promise<AgentMetadata[]> {
    return this.configStore.listAgents();
  }
}
