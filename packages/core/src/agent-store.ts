/**
 * AgentStore — unified interface for agent configuration storage.
 *
 * Implementations:
 *   - InMemoryAgentStore (SDK-embedded mode, populated from `GatewayConfig.agents`)
 *   - Host-provided store (embedded backend, e.g. PostgresAgentStore in Lobu)
 */

import type { PluginsConfig } from "./plugin-types";
import type {
  AgentEgressConfig,
  AuthProfile,
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
 * Canonical shape. Every agent store implementation conforms to this
 * interface.
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
  /** Egress judge configuration (operator-level overrides for the LLM egress judge). */
  egressConfig?: AgentEgressConfig;
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
  /**
   * Guardrails enabled for this agent, by registered name. The gateway
   * resolves these against its GuardrailRegistry at each stage (input,
   * output, pre-tool) and halts the run on the first trip.
   */
  guardrails?: string[];
  /** OpenClaw plugin configuration */
  pluginsConfig?: PluginsConfig;
  /**
   * Reusable auth profiles persisted by host stores (e.g. Lobu's Postgres
   * store). Lobu's gateway runtime uses UserAuthProfileStore instead, but the
   * host's settings JSON column still round-trips this list.
   */
  authProfiles?: AuthProfile[];
  /** Installed providers for this agent (index 0 = primary). */
  installedProviders?: InstalledProvider[];
  /** Enable verbose logging (show tool calls, reasoning, etc.) */
  verboseLogging?: boolean;
  /**
   * MCP tool patterns the operator has pre-approved. Each entry is a grant
   * pattern (e.g. "/mcp/gmail/tools/send_email" or "/mcp/linear/tools/*").
   * Synced to the grant store at deployment time to bypass the approval card
   * for matching tools. Operator-only — skills cannot set this.
   */
  preApprovedTools?: string[];
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
  /**
   * Owning organization id. Optional in the type for back-compat with
   * in-memory stores that predate per-tenant scoping; populated by the
   * postgres-backed store. The public Agent API route reads this to stamp
   * worker tokens with the agent's org so the egress proxy can scope
   * per-tenant gates (grants, judge cache, judge policy).
   */
  organizationId?: string;
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
  agentId?: string;
  /**
   * Organization id this connection belongs to. Optional in the type for
   * back-compat with in-memory tests, but required at the storage layer
   * (`agent_connections.organization_id` is NOT NULL post-Phase-C).
   */
  organizationId?: string;
  config: Record<string, any>;
  settings: ConnectionSettings;
  metadata: Record<string, any>;
  status: "active" | "stopped" | "error";
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

// ── Grants ──────────────────────────────────────────────────────────────────

/** Grant kind. Domain grants and MCP-tool grants share the same store but
 *  callers (UI, audit) often want to filter to one. The MCP path is detected
 *  by the leading slash in the pattern. */
export type GrantKind = "domain" | "mcp_tool";

export interface Grant {
  pattern: string;
  kind: GrantKind;
  expiresAt: number | null;
  grantedAt: number;
  denied?: boolean;
}

export function inferGrantKind(pattern: string): GrantKind {
  return pattern.startsWith("/") ? "mcp_tool" : "domain";
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
}

/**
 * Platform wiring storage.
 * Connections (Telegram, Slack, etc.) + channel bindings.
 */
export interface AgentConnectionStore {
  getConnection(connectionId: string): Promise<StoredConnection | null>;
  listConnections(filter?: {
    agentId?: string;
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
 * User-agent ownership storage. Domain/MCP grants live in GrantStore
 * (`public.grants`), not here.
 */
export interface AgentAccessStore {
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
