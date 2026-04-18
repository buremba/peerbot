/**
 * AgentStore — unified interface for agent configuration storage.
 *
 * Implementations:
 *   - InMemoryAgentStore (default, populated from files or API)
 *   - Host-provided store (embedded mode, e.g. PostgresAgentStore in Owletto)
 */

import type { PluginsConfig } from "./plugin-types";
import type {
  InstalledProvider,
  McpServerConfig,
  ModelSelectionState,
  NetworkConfig,
  NixConfig,
  ProviderModelPreferences,
  SkillsConfig,
  ToolsConfig,
} from "./types";

// ── Agent Settings ──────────────────────────────────────────────────────────

/**
 * Agent settings — configurable per agentId.
 *
 * Canonical shape. Both the in-memory store and the gateway Redis store use
 * this interface; the gateway re-exports it from `auth/settings/index.ts` for
 * legacy import paths.
 */
export interface AgentSettings {
  /** Display-only model reference (legacy; prefer modelSelection). */
  model?: string;
  /** Model selection mode (auto provider/default model vs pinned provider/model). */
  modelSelection?: ModelSelectionState;
  /** Per-provider preferred model for auto mode. */
  providerModelPreferences?: ProviderModelPreferences;
  /** Network access configuration */
  networkConfig?: NetworkConfig;
  /** Nix environment configuration */
  nixConfig?: NixConfig;
  /** Additional MCP servers */
  mcpServers?: Record<string, McpServerConfig>;
  /** Internal marker: MCP IDs already acknowledged to the user in chat */
  mcpInstallNotified?: Record<string, number>;
  /** Workspace identity/instruction files (markdown content) */
  soulMd?: string;
  userMd?: string;
  identityMd?: string;
  /** Skills configuration loaded from local SKILL.md files. */
  skillsConfig?: SkillsConfig;
  /** Tool permission configuration — allowed/denied tools (worker-side visibility). */
  toolsConfig?: ToolsConfig;
  /** OpenClaw plugin configuration */
  pluginsConfig?: PluginsConfig;
  /** Installed providers for this agent (index 0 = primary). */
  installedProviders?: InstalledProvider[];
  /** Enable verbose logging (show tool calls, reasoning, etc.) */
  verboseLogging?: boolean;
  /** Template agent this sandbox was cloned from (for credential fallback) */
  templateAgentId?: string;
  /**
   * MCP tool patterns the operator has pre-approved. Each entry is a grant
   * pattern (e.g. "/mcp/gmail/tools/send_email" or "/mcp/linear/tools/*").
   * Synced to the grant store at deployment time to bypass the approval card
   * for matching tools. Operator-only — skills cannot set this.
   */
  preApprovedTools?: string[];
  /**
   * Default delivery target for scheduled fires that omit `deliverTo`.
   * Same format as `DeclaredSchedule.deliverTo`:
   *   "<platform>:<connectionSlug>:<channelId>[:<threadTs>]"
   */
  defaultScheduleChannel?: string;
  /** Last updated timestamp */
  updatedAt: number;
}

// ── Agent Metadata ──────────────────────────────────────────────────────────

export interface AgentMetadata {
  agentId: string;
  name: string;
  description?: string;
  owner: { platform: string; userId: string };
  isWorkspaceAgent?: boolean;
  workspaceId?: string;
  parentConnectionId?: string;
  createdAt: number;
  lastUsedAt?: number;
}

// ── Connections ─────────────────────────────────────────────────────────────

export interface ConnectionSettings {
  allowFrom?: string[];
  allowGroups?: boolean;
  userConfigScopes?: string[];
}

export interface StoredConnection {
  id: string;
  platform: string;
  templateAgentId?: string;
  config: Record<string, any>;
  settings: ConnectionSettings;
  metadata: Record<string, any>;
  status: "active" | "stopped" | "error";
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

// ── Grants ──────────────────────────────────────────────────────────────────

export interface Grant {
  pattern: string;
  expiresAt: number | null;
  grantedAt: number;
  denied?: boolean;
}

// ── Channel Bindings ────────────────────────────────────────────────────────

export interface ChannelBinding {
  agentId: string;
  platform: string;
  channelId: string;
  teamId?: string;
  createdAt: number;
}

// ── Sub-Store Interfaces ──────────────────────────────────────────────────

/**
 * Agent identity & configuration storage.
 * Settings (model, skills, providers, etc.) + metadata (name, owner, etc.)
 */
export interface AgentConfigStore {
  getSettings(agentId: string): Promise<AgentSettings | null>;
  saveSettings(agentId: string, settings: AgentSettings): Promise<void>;
  updateSettings(
    agentId: string,
    updates: Partial<AgentSettings>
  ): Promise<void>;
  deleteSettings(agentId: string): Promise<void>;
  hasSettings(agentId: string): Promise<boolean>;

  getMetadata(agentId: string): Promise<AgentMetadata | null>;
  saveMetadata(agentId: string, metadata: AgentMetadata): Promise<void>;
  updateMetadata(
    agentId: string,
    updates: Partial<AgentMetadata>
  ): Promise<void>;
  deleteMetadata(agentId: string): Promise<void>;
  hasAgent(agentId: string): Promise<boolean>;
  listAgents(): Promise<AgentMetadata[]>;
  listSandboxes(connectionId: string): Promise<AgentMetadata[]>;
}

/**
 * Find the first non-sandbox agent with installed providers configured.
 * Used to pick a default template agent when creating ephemeral/API agents.
 */
export async function findTemplateAgentId(
  store: Pick<AgentConfigStore, "listAgents" | "getSettings">
): Promise<string | null> {
  const agents = await store.listAgents();

  for (const agent of agents) {
    if (agent.parentConnectionId) continue;
    const settings = await store.getSettings(agent.agentId);
    if (settings?.installedProviders?.length) {
      return agent.agentId;
    }
  }

  return null;
}

/**
 * Platform wiring storage.
 * Connections (Telegram, Slack, etc.) + channel bindings.
 */
export interface AgentConnectionStore {
  getConnection(connectionId: string): Promise<StoredConnection | null>;
  listConnections(filter?: {
    templateAgentId?: string;
    platform?: string;
  }): Promise<StoredConnection[]>;
  saveConnection(connection: StoredConnection): Promise<void>;
  updateConnection(
    connectionId: string,
    updates: Partial<StoredConnection>
  ): Promise<void>;
  deleteConnection(connectionId: string): Promise<void>;

  getChannelBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<ChannelBinding | null>;
  createChannelBinding(binding: ChannelBinding): Promise<void>;
  deleteChannelBinding(
    platform: string,
    channelId: string,
    teamId?: string
  ): Promise<void>;
  listChannelBindings(agentId: string): Promise<ChannelBinding[]>;
  deleteAllChannelBindings(agentId: string): Promise<number>;
}

/**
 * Permissions & ownership storage.
 * Grants (skill/domain access) + user-agent associations.
 */
export interface AgentAccessStore {
  grant(
    agentId: string,
    pattern: string,
    expiresAt: number | null,
    denied?: boolean
  ): Promise<void>;
  hasGrant(agentId: string, pattern: string): Promise<boolean>;
  isDenied(agentId: string, pattern: string): Promise<boolean>;
  listGrants(agentId: string): Promise<Grant[]>;
  revokeGrant(agentId: string, pattern: string): Promise<void>;

  addUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void>;
  removeUserAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<void>;
  listUserAgents(platform: string, userId: string): Promise<string[]>;
  ownsAgent(
    platform: string,
    userId: string,
    agentId: string
  ): Promise<boolean>;
}

// ── AgentStore (full intersection) ────────────────────────────────────────

/**
 * Full storage interface — intersection of all sub-stores.
 * Implementations (InMemoryAgentStore, etc.) satisfy all 3.
 * Hosts can provide individual sub-stores via GatewayOptions instead.
 */
export type AgentStore = AgentConfigStore &
  AgentConnectionStore &
  AgentAccessStore;
