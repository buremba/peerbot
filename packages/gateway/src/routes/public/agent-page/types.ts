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

export type SettingsScope = "agent" | "sandbox";
export type SettingsSource = "local" | "inherited" | "mixed";
export type SettingsSectionKey =
  | "model"
  | "system-prompt"
  | "skills"
  | "packages"
  | "permissions"
  | "schedules"
  | "logging";

export interface SectionView {
  source: SettingsSource;
  editable: boolean;
  canReset: boolean;
  hasLocalOverride: boolean;
}

export interface ProviderView {
  id: string;
  source: SettingsSource;
  canEdit: boolean;
  canReset: boolean;
  hasLocalOverride: boolean;
}

export interface ModelSelectionState {
  mode: "auto" | "pinned";
  pinnedModel?: string;
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

export interface AgentInfo {
  agentId: string;
  name: string;
  isWorkspaceAgent?: boolean;
  channelCount: number;
  description?: string;
}

export interface SettingsState {
  agentId: string;
  scope: SettingsScope;
  PROVIDERS: Record<string, ProviderInfo>;
  providerOrder: string[];
  providerModels: Record<string, ModelOption[]>;
  modelSelection: ModelSelectionState;
  providerModelPreferences: Record<string, string>;
  catalogProviders: CatalogProvider[];
  memoryEnabled: boolean;
  initialSkills: Skill[];
  initialMcpServers: Record<string, McpConfig>;
  prefillSkills: PrefillSkill[];
  prefillMcpServers: PrefillMcp[];
  prefillGrants: string[];
  prefillNixPackages: string[];
  prefillProviders: string[];
  initialNixPackages: string[];
  agentName: string;
  agentDescription: string;
  hasChannelId: boolean;
  verboseLogging: boolean;
  identityMd: string;
  soulMd: string;
  userMd: string;
  // Injected by the server into the HTML shell
  platform: string;
  userId: string;
  channelId?: string;
  teamId?: string;
  message?: string;
  showSwitcher: boolean;
  agents: AgentInfo[];
  hasNoProviders: boolean;
  configManagedProviders: string[];
  // Provider icon URLs for rendering
  providerIconUrls: Record<string, string>;
  // Settings mode and scoped access
  settingsMode: "admin" | "user";
  allowedScopes?: string[];
  // Whether the user has admin access (authenticated via OAuth or admin password)
  isAdmin?: boolean;
  // Whether this agent is a sandbox (auto-created under a connection)
  isSandbox?: boolean;
  // Platform of the sandbox agent's owner (for displaying platform icon)
  ownerPlatform?: string;
  // Template/base agent this sandbox promotes into
  templateAgentId?: string;
  templateAgentName?: string;
  sectionViews: Record<SettingsSectionKey, SectionView>;
  providerViews: Record<string, ProviderView>;
  // Skill registries
  globalRegistries: { id: string; type: string; apiUrl: string }[];
  initialRegistries: { id: string; type: string; apiUrl: string }[];
  // Source conversation context for post-install callbacks
  conversationId?: string;
  connectionId?: string;
}

export interface Connection {
  id: string;
  platform: string;
  templateAgentId?: string;
  config: Record<string, any>;
  settings: {
    allowFrom?: string[];
    allowGroups?: boolean;
    userConfigScopes?: string[];
  };
  metadata: Record<string, any>;
  status: "active" | "stopped" | "error";
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
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
