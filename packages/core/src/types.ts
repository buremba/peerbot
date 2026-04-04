// ============================================================================
// Provider Catalog Types
// ============================================================================

/**
 * Represents a provider installed for a specific agent.
 * Stored in AgentSettings.installedProviders as an ordered array (index 0 = primary).
 */
export interface InstalledProvider {
  providerId: string; // "claude", "chatgpt", "gemini", "z-ai"
  installedAt: number;
  config?: {
    baseUrl?: string; // override upstream (e.g. z.ai proxy)
    [key: string]: unknown;
  };
}

/**
 * CLI backend configuration for pi-agent integration.
 * Providers can ship CLI tools that pi-agent invokes as backends.
 */
export interface CliBackendConfig {
  name: string; // "claude-code", "codex"
  command: string; // "/usr/local/bin/claude"
  args?: string[];
  env?: Record<string, string>;
  modelArg?: string; // "--model"
  sessionArg?: string; // "--session"
}

// ============================================================================
// Auth Profile Types
// ============================================================================

/**
 * Unified authentication profile for any model provider.
 * Stored in AgentSettings.authProfiles as an ordered array (index 0 = primary).
 */
export interface AuthProfile {
  id: string; // UUID
  provider: string; // "anthropic", "openai-codex", "gemini", "nvidia"
  model: string; // Full model ref: "openai-codex/gpt-5.2-codex"
  credential: string; // API key or OAuth access token
  label: string; // "user@gmail.com", "sk-ant-...1234"
  authType: "oauth" | "device-code" | "api-key";
  metadata?: {
    email?: string;
    expiresAt?: number;
    refreshToken?: string;
    accountId?: string;
  };
  createdAt: number;
}

export interface SessionContext {
  // Core identifiers
  platform: string; // Platform identifier (e.g., "slack", "discord", "teams")
  channelId: string;
  userId: string;
  messageId: string; // Required - always needed for tracking

  // Optional context
  conversationId?: string;
  teamId?: string; // Platform workspace/team identifier
  userDisplayName?: string; // For logging/display purposes
  workingDirectory?: string;
  customInstructions?: string;
  conversationHistory?: ConversationMessage[];
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
}

// ============================================================================
// Conversation History Types
// ============================================================================

// ============================================================================
// Skills Configuration Types
// ============================================================================

/**
 * Per-skill thinking budget level.
 * Controls how much reasoning the model applies when executing a skill.
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * MCP server declared by a skill manifest.
 */
export interface SkillMcpServer {
  id: string;
  name?: string;
  url?: string;
  type?: "sse" | "stdio";
  command?: string;
  args?: string[];
  oauth?: {
    authUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    grantType?: string;
    responseType?: string;
  };
  resource?: string;
  inputs?: Array<{ id: string; label?: string; type?: string }>;
  headers?: Record<string, string>;
}

/**
 * Individual skill configuration.
 * Skills are SKILL.md files from GitHub repos that provide instructions to Claude.
 */
export interface SkillConfig {
  /** Skill repository in owner/repo format (e.g., "anthropics/skills/pdf") */
  repo: string;
  /** Skill name derived from SKILL.md frontmatter or folder name */
  name: string;
  /** Optional description from SKILL.md frontmatter */
  description?: string;
  /** Short always-inlined instruction block for critical rules */
  instructions?: string;
  /** Whether this skill is currently enabled */
  enabled: boolean;
  /** True for system-defined skills (from system-skills.json). Cannot be removed by users. */
  system?: boolean;
  /** Cached SKILL.md content (fetched from GitHub) */
  content?: string;
  /** When the content was last fetched (timestamp ms) */
  contentFetchedAt?: number;
  /** MCP servers declared by the skill */
  mcpServers?: SkillMcpServer[];
  /** System packages declared by the skill (nix) */
  nixPackages?: string[];
  /** Network domains the skill needs access to (legacy flat list) */
  permissions?: string[];
  /** Network access policy declared by the skill */
  networkConfig?: { allowedDomains?: string[]; deniedDomains?: string[] };
  /** Tool permission policy declared by the skill */
  toolPermissions?: { allow?: string[]; deny?: string[] };
  /** AI providers the skill requires */
  providers?: string[];
  /** Preferred model for this skill (e.g., "anthropic/claude-opus-4") */
  modelPreference?: string;
  /** Thinking level budget for this skill */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Skills configuration for agent settings.
 * Contains list of configured skills that can be enabled/disabled.
 */
export interface SkillsConfig {
  /** List of configured skills */
  skills: SkillConfig[];
}

/**
 * Platform-agnostic history message format.
 * Used to pass conversation history to workers.
 */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Display name of the message sender */
  userName?: string;
  /** Platform-specific message ID for deduplication */
  messageId?: string;
}

/**
 * Network configuration for worker sandbox isolation.
 * Controls which domains the worker can access via HTTP proxy.
 *
 * Filtering rules:
 * - deniedDomains are checked first (take precedence)
 * - allowedDomains are checked second
 * - If neither matches, request is denied
 *
 * Domain pattern format:
 * - "example.com" - exact match
 * - ".example.com" or "*.example.com" - matches subdomains
 */
export interface NetworkConfig {
  /** Domains the worker is allowed to access. Empty array = no network access. */
  allowedDomains?: string[];
  /** Domains explicitly blocked (takes precedence over allowedDomains). */
  deniedDomains?: string[];
}

/**
 * Nix environment configuration for agent workspace.
 * Allows agents to run with specific Nix packages or flakes.
 *
 * Resolution priority:
 * 1. API-provided flakeUrl (highest)
 * 2. API-provided packages
 * 3. flake.nix in git repo
 * 4. shell.nix in git repo
 * 5. .nix-packages file in git repo
 */
export interface NixConfig {
  /** Nix flake URL (e.g., "github:user/repo#devShell") */
  flakeUrl?: string;
  /** Nixpkgs packages to install (e.g., ["python311", "ffmpeg"]) */
  packages?: string[];
}

// ============================================================================
// Tools Configuration Types
// ============================================================================

/**
 * Tool permission configuration for agent settings.
 * Follows Claude Code's permission patterns for consistency.
 *
 * Pattern formats (Claude Code compatible):
 * - "Read" - exact tool match
 * - "Bash(git:*)" - Bash with command filter (only git commands)
 * - "Bash(npm:*)" - Bash with npm commands only
 * - "mcp__servername__*" - all tools from an MCP server
 * - "*" - wildcard (all tools)
 *
 * Filtering rules:
 * - deniedTools are checked first (take precedence)
 * - allowedTools are checked second
 * - If strictMode=true, only allowedTools are permitted
 * - If strictMode=false, defaults + allowedTools are permitted
 */
export interface ToolsConfig {
  /**
   * Tools to auto-allow (in addition to defaults unless strictMode=true).
   * Supports patterns like "Bash(git:*)" or "mcp__github__*".
   */
  allowedTools?: string[];

  /**
   * Tools to always deny (takes precedence over allowedTools).
   * Use to block specific tools even if they're in defaults.
   */
  deniedTools?: string[];

  /**
   * If true, ONLY allowedTools are permitted (ignores defaults).
   * If false (default), allowedTools are ADDED to default permissions.
   */
  strictMode?: boolean;
}

/**
 * MCP server configuration for per-agent MCP servers.
 * Supports both HTTP/SSE and stdio MCP servers.
 */
export interface McpServerConfig {
  /** For HTTP/SSE MCPs: upstream URL */
  url?: string;
  /** Server type: "sse" for HTTP MCPs, "stdio" for command-based */
  type?: "sse" | "stdio";
  /** For stdio MCPs: command to execute */
  command?: string;
  /** For stdio MCPs: command arguments */
  args?: string[];
  /** For stdio MCPs: environment variables */
  env?: Record<string, string>;
  /** Additional headers for HTTP MCPs */
  headers?: Record<string, string>;
  /** Optional description for the MCP */
  description?: string;
}

/**
 * Per-agent MCP configuration.
 * These MCPs are ADDED to global MCPs (not replacing).
 */
export interface AgentMcpConfig {
  /** Additional MCP servers for this agent */
  mcpServers: Record<string, McpServerConfig>;
}

export interface MemoryFlushOptions {
  enabled?: boolean;
  softThresholdTokens?: number;
  systemPrompt?: string;
  prompt?: string;
}

export interface AgentCompactionOptions {
  memoryFlush?: MemoryFlushOptions;
}

/**
 * Platform-agnostic execution hints passed through gateway → worker.
 * Flexible types (string | string[]) and index signature allow forward
 * compatibility for different agent implementations.
 */
export interface AgentOptions {
  runtime?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  allowedTools?: string | string[];
  disallowedTools?: string | string[];
  timeoutMinutes?: number | string;
  compaction?: AgentCompactionOptions;
  // Additional settings passed through from gateway (can be nested objects)
  networkConfig?: Record<string, unknown>;
  envVars?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Platform-agnostic log level type
 * Maps to common logging levels used across different platforms
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

// ============================================================================
// Instruction Provider Types
// ============================================================================

/**
 * Context information passed to instruction providers
 */
export interface InstructionContext {
  userId: string;
  agentId: string;
  sessionKey: string;
  workingDirectory: string;
  availableProjects?: string[];
  userPrompt?: string;
}

/**
 * Interface for components that contribute custom instructions
 */
export interface InstructionProvider {
  /** Unique identifier for this provider */
  name: string;

  /** Priority for ordering (lower = earlier in output) */
  priority: number;

  /**
   * Generate instruction text for this provider
   * @param context - Context information for instruction generation
   * @returns Instruction text or empty string if none
   */
  getInstructions(context: InstructionContext): Promise<string> | string;
}

// ============================================================================
// Thread Response Types
// ============================================================================

/**
 * Shared payload contract for worker → platform thread responses.
 * Ensures gateway consumers and workers stay type-aligned.
 */
export interface ThreadResponsePayload {
  messageId: string;
  channelId: string;
  conversationId: string;
  userId: string;
  teamId: string;
  platform?: string; // Platform identifier (slack, whatsapp, api, etc.) for routing
  content?: string; // Used only for ephemeral messages (OAuth/auth flows)
  delta?: string;
  isFullReplacement?: boolean;
  processedMessageIds?: string[];
  error?: string;
  errorCode?: string;
  timestamp: number;
  originalMessageId?: string;
  moduleData?: Record<string, unknown>;
  botResponseId?: string;
  ephemeral?: boolean; // If true, message should be sent as ephemeral (only visible to user)
  platformMetadata?: Record<string, unknown>;
  statusUpdate?: {
    elapsedSeconds: number;
    state: string; // e.g., "is running" or "is scheduling"
  };

  // Exec-specific response fields (for jobType === "exec")
  execId?: string; // Exec job ID for response routing
  execStream?: "stdout" | "stderr"; // Which stream this delta is from
  execExitCode?: number; // Process exit code (sent on completion)
}

// ============================================================================
// User Interaction Types
// ============================================================================

/**
 * Suggested prompt for user
 */
export interface SuggestedPrompt {
  title: string; // Short label shown as chip
  message: string; // Full message sent when clicked
}

/**
 * Skill registry entry (global or per-agent).
 */
export interface RegistryEntry {
  id: string;
  type: string;
  apiUrl: string;
}

/**
 * Non-blocking suggestions - agent continues immediately
 * Used for optional next steps
 */
export interface UserSuggestion {
  id: string;
  userId: string;
  conversationId: string;
  channelId: string;
  teamId?: string;

  blocking: false; // Always false - distinguishes from interactions

  prompts: SuggestedPrompt[];
}
