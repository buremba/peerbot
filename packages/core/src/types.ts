export interface SessionContext {
  // Core identifiers
  platform: string; // Platform identifier (e.g., "slack", "discord", "teams")
  channelId: string;
  userId: string;
  messageId: string; // Required - always needed for tracking

  // Optional context
  threadId?: string;
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

/**
 * History timeframe configuration options for fetching conversation history.
 * Determines how far back to fetch messages when starting a new thread.
 */
export type HistoryTimeframe = "1d" | "7d" | "30d" | "365d" | "all";

/**
 * Configuration for conversation history fetching per-agent.
 * Controls when and how much historical context is provided to Claude.
 */
export interface HistoryConfig {
  /** Enable conversation history fetching on first message in thread */
  enabled: boolean;
  /** How far back to fetch history */
  timeframe: HistoryTimeframe;
  /** Maximum number of messages to include (default: 100) */
  maxMessages?: number;
  /** Include bot's own messages in history (default: true) */
  includeBotMessages?: boolean;
}

// ============================================================================
// Skills Configuration Types
// ============================================================================

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
  /** Whether this skill is currently enabled */
  enabled: boolean;
  /** Cached SKILL.md content (fetched from GitHub) */
  content?: string;
  /** When the content was last fetched (timestamp ms) */
  contentFetchedAt?: number;
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
 * Filtering rules (sandbox-runtime compatible):
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
 * Git repository configuration for agent workspace initialization.
 * Allows agents to work within a cloned git repository.
 *
 * Authentication priority:
 * 1. GitHub App (if GITHUB_APP_ID configured)
 * 2. Global PAT (if GITHUB_PERSONAL_ACCESS_TOKEN configured)
 * 3. No auth (public repos only)
 */
export interface GitConfig {
  /** Repository URL (e.g., https://github.com/owner/repo) */
  repoUrl: string;
  /** Branch to checkout (default: repo's default branch) */
  branch?: string;
  /** Sparse checkout paths - only checkout specific directories */
  sparse?: string[];
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

/**
 * Platform-agnostic execution hints passed through gateway → worker.
 * Flexible types (string | string[]) and index signature allow forward
 * compatibility for different agent implementations.
 */
export interface AgentOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  allowedTools?: string | string[];
  disallowedTools?: string | string[];
  timeoutMinutes?: number | string;
  // Additional settings passed through from gateway (can be nested objects)
  networkConfig?: Record<string, unknown>;
  gitConfig?: Record<string, unknown>;
  envVars?: Record<string, string>;
  historyConfig?: Record<string, unknown>;
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
  threadId: string;
  userId: string;
  teamId: string;
  platform?: string; // Platform identifier (slack, whatsapp, api, etc.) for routing
  content?: string; // Used only for ephemeral messages (OAuth/auth flows)
  delta?: string;
  isFullReplacement?: boolean;
  processedMessageIds?: string[];
  error?: string;
  timestamp: number;
  originalMessageId?: string;
  moduleData?: Record<string, unknown>;
  botResponseId?: string;
  ephemeral?: boolean; // If true, message should be sent as ephemeral (only visible to user)
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
 * Form field schema for inline inputs
 */
export interface FieldSchema {
  type: "text" | "select" | "textarea" | "number" | "checkbox" | "multiselect";
  label?: string; // Defaults to capitalized field name
  placeholder?: string;
  options?: string[]; // For select/multiselect
  required?: boolean;
  default?: any;
}

/**
 * Interaction options - determines UX pattern (all inline, no modals):
 * - string[] → Simple radio buttons (inline, auto-submit on selection)
 * - Record<string, FieldSchema> → Single inline form with submit button
 * - Record<string, Record<string, FieldSchema>> → Multi-section form (inline section buttons + forms)
 */
export type InteractionOptions =
  | string[]
  | Record<string, FieldSchema>
  | Record<string, Record<string, FieldSchema>>;

/**
 * User response to an interaction
 * Format depends on interaction type:
 * - Simple radio: { answer: string }
 * - Single form: { formData: Record<string, any> }
 * - Multi-section form: { formData: Record<sectionName, Record<fieldName, value>> }
 */
export interface UserInteractionResponse {
  answer?: string; // For simple radio button responses
  formData?: Record<string, any>; // For single form or multi-section form (nested by section)
  timestamp: number;
}

/**
 * Interaction type classification
 */
export type InteractionType =
  | "plan_approval"
  | "tool_approval"
  | "question"
  | "form";

/**
 * Blocking user interaction - agent waits for response
 */
export interface UserInteraction {
  id: string;
  userId: string;
  threadId: string;
  channelId: string;
  teamId?: string;

  blocking: true; // Always true - distinguishes from suggestions

  interactionType: InteractionType; // Type of interaction for recovery/context

  question: string; // The question or prompt to display
  options: InteractionOptions; // Determines UX pattern (radio/single-form/multi-section)

  metadata?: any; // Optional metadata for tracking/context

  status: "pending" | "responded" | "expired";
  response?: UserInteractionResponse;
  createdAt: number;
  expiresAt: number;
  respondedAt?: number;
  respondedByUserId?: string; // Who actually clicked/submitted (may differ from userId)

  // Active section for multi-section forms
  activeSection?: string;
  // Partial data (for multi-section workflows before final submit)
  partialData?: Record<string, Record<string, any>>;
}

/**
 * Pending interaction state for worker startup recovery
 * Note: Only contains unanswered interactions (those still in pending set)
 */
export interface PendingInteraction {
  id: string;
  type: InteractionType;
  question: string;
  createdAt: number;
}

/**
 * Suggested prompt for user
 */
export interface SuggestedPrompt {
  title: string; // Short label shown as chip
  message: string; // Full message sent when clicked
}

/**
 * Non-blocking suggestions - agent continues immediately
 * Used for optional next steps
 */
export interface UserSuggestion {
  id: string;
  userId: string;
  threadId: string;
  channelId: string;
  teamId?: string;

  blocking: false; // Always false - distinguishes from interactions

  prompts: SuggestedPrompt[];
}
