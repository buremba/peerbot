/**
 * Agent Settings API response types.
 * These mirror the gateway API response shapes used by UI consumers.
 */

import type { RegistryEntry } from "./types";

export type { RegistryEntry };

export interface ProviderInfo {
  name: string;
  authType: "oauth" | "device-code" | "api-key";
  supportedAuthTypes: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
  capabilities: (
    | "text"
    | "image-generation"
    | "speech-to-text"
    | "text-to-speech"
  )[];
}

export interface CatalogProvider {
  id: string;
  name: string;
  iconUrl: string;
  authType: "oauth" | "device-code" | "api-key";
  supportedAuthTypes: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions: string;
  apiKeyPlaceholder: string;
  capabilities: (
    | "text"
    | "image-generation"
    | "speech-to-text"
    | "text-to-speech"
  )[];
}

export interface ModelOption {
  label: string;
  value: string;
}

export interface ModelSelectionState {
  mode: "auto" | "pinned";
  pinnedModel?: string;
}

export interface SkillIntegrationInfo {
  id: string;
  label?: string;
  authType?: "oauth" | "api-key";
  scopes?: string[];
  apiDomains?: string[];
}

export interface SkillMcpServerInfo {
  id: string;
  name?: string;
  url?: string;
  type?: "sse" | "stdio";
  command?: string;
  args?: string[];
}

export interface Skill {
  repo: string;
  name: string;
  description: string;
  enabled: boolean;
  system?: boolean;
  content?: string;
  contentFetchedAt?: number;
  integrations?: SkillIntegrationInfo[];
  mcpServers?: SkillMcpServerInfo[];
  nixPackages?: string[];
  permissions?: string[];
  providers?: string[];
  modelPreference?: string;
  thinkingLevel?: string;
}

export interface McpConfig {
  enabled?: boolean;
  url?: string;
  command?: string;
  args?: string[];
  type?: string;
  description?: string;
}

export interface Schedule {
  scheduleId: string;
  task: string;
  scheduledFor: string;
  status: "pending" | "triggered" | "cancelled";
  isRecurring?: boolean;
  cron?: string;
  iteration?: number;
  maxIterations?: number;
}

export interface PrefillSkill {
  repo: string;
  name?: string;
  description?: string;
}

export interface PrefillMcp {
  id: string;
  name?: string;
  url?: string;
  type?: string;
  command?: string;
  args?: string[];
  envVars?: string[];
}

export interface ProviderState {
  status: string;
  connected: boolean;
  userConnected: boolean;
  systemConnected: boolean;
  showAuthFlow: boolean;
  showCodeInput: boolean;
  showDeviceCode: boolean;
  showApiKeyInput: boolean;
  activeAuthTab: string;
  activeAuthType?: string | null;
  authMethods?: string[];
  code: string;
  apiKey: string;
  userCode: string;
  verificationUrl: string;
  pollStatus: string;
  deviceAuthId: string;
  selectedModel: string;
  modelQuery: string;
  showModelDropdown: boolean;
}

export interface PermissionGrant {
  pattern: string;
  expiresAt: number | null;
  denied?: boolean;
  grantedAt?: number;
}

export interface IntegrationStatusEntry {
  label: string;
  connected: boolean;
  configured: boolean;
  accounts: { accountId: string; grantedScopes: string[] }[];
  availableScopes: string[];
}

export interface AgentInfo {
  agentId: string;
  name: string;
  isWorkspaceAgent?: boolean;
  channelCount: number;
  description?: string;
}

export interface SettingsSnapshot {
  identityMd: string;
  soulMd: string;
  userMd: string;
  verboseLogging: boolean;
  primaryProvider: string;
  providerOrder: string;
  nixPackages: string;
  skills: string;
  mcpServers: string;
  permissions: string;
  providerModelPreferences: string;
  registries: string;
}

export interface Connection {
  id: string;
  platform: string;
  templateAgentId?: string;
  config: Record<string, unknown>;
  settings: {
    allowFrom?: string[];
    allowGroups?: boolean;
    userConfigScopes?: string[];
  };
  metadata: Record<string, unknown>;
  status: "active" | "stopped" | "error";
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderStatus {
  connected: boolean;
  userConnected: boolean;
  systemConnected: boolean;
  activeAuthType?: "oauth" | "device-code" | "api-key";
  authMethods?: string[];
}

export interface AgentConfigResponse {
  agentId: string;

  instructions: {
    identity: string;
    soul: string;
    user: string;
  };

  providers: {
    order: string[];
    status: Record<string, ProviderStatus>;
    catalog: CatalogProvider[];
    meta: Record<string, ProviderInfo>;
    models: Record<string, ModelOption[]>;
    preferences: Record<string, string>;
    icons: Record<string, string>;
    modelSelection: ModelSelectionState;
    baseNames: string[];
    configManaged: string[];
  };

  skills: Skill[];
  mcpServers: Record<string, McpConfig>;

  tools: {
    nixPackages: string[];
    permissions: PermissionGrant[];
    schedules: Schedule[];
    registries: RegistryEntry[];
    globalRegistries: RegistryEntry[];
  };

  settings: {
    verboseLogging: boolean;
    memoryEnabled: boolean;
  };

  integrationStatus: Record<string, IntegrationStatusEntry>;
}
