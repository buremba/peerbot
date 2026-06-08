/**
 * Gateway API response types shared between the server and UI consumers.
 */

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

export interface SkillMcpServerInfo {
  id: string;
  name?: string;
  url?: string;
  type?: "sse" | "streamable-http" | "stdio";
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

export interface Connection {
  id: string;
  platform: string;
  agentId?: string;
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
