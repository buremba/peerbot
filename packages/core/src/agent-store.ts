/**
 * AgentStore — unified interface for agent configuration storage.
 *
 * Replaces 6 separate Redis-backed stores with a single abstraction.
 * Implementations:
 *   - RedisAgentStore (CLI mode, seeded from lobu.toml)
 *   - Host-provided store (embedded mode, e.g. PostgresAgentStore in Owletto)
 */

import type { PluginsConfig } from "./plugin-types";
import type {
  AuthProfile,
  InstalledProvider,
  McpServerConfig,
  NetworkConfig,
  NixConfig,
  RegistryEntry,
  SkillsConfig,
  ToolsConfig,
} from "./types";

// ── Agent Settings ──────────────────────────────────────────────────────────

export interface AgentSettings {
  model?: string;
  modelSelection?: { mode: "auto" | "pinned"; pinnedModel?: string };
  providerModelPreferences?: Record<string, string>;
  networkConfig?: NetworkConfig;
  nixConfig?: NixConfig;
  mcpServers?: Record<string, McpServerConfig>;
  mcpInstallNotified?: Record<string, number>;
  soulMd?: string;
  userMd?: string;
  identityMd?: string;
  skillsConfig?: SkillsConfig;
  toolsConfig?: ToolsConfig;
  pluginsConfig?: PluginsConfig;
  authProfiles?: AuthProfile[];
  installedProviders?: InstalledProvider[];
  skillRegistries?: RegistryEntry[];
  verboseLogging?: boolean;
  templateAgentId?: string;
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
 * Implementations (RedisAgentStore, PostgresAgentStore) satisfy all 3.
 * Hosts can provide individual sub-stores via GatewayOptions instead.
 */
export type AgentStore = AgentConfigStore &
  AgentConnectionStore &
  AgentAccessStore;
