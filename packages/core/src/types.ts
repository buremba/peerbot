import type { GuardrailStage } from "./guardrails/types";
import type { SecretRef } from "./secret-refs";

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

/**
 * Unified authentication profile for any model provider.
 * Persisted per-(userId, agentId) by the gateway's UserAuthProfileStore;
 * also synthesized at read time from declared credentials and SDK-supplied
 * ephemeral credentials.
 *
 * **Invariant:** at any point in time, a profile has **exactly one** credential
 * source set — either `credentialRef` (persisted profiles resolved through the
 * secret store) or `credential` (in-memory runtime profiles for SDK-embedded
 * use). The same rule applies to `metadata.refreshToken` / `refreshTokenRef`.
 * The persistence layer is responsible for never writing plaintext credentials
 * into the stored JSON.
 */
export interface AuthProfile {
  id: string; // UUID
  provider: string; // "anthropic", "openai-codex", "gemini", "nvidia"
  model: string; // Full model ref: "openai-codex/gpt-5.2-codex"
  /** Runtime-only resolved credential value. Never persisted. */
  credential?: string;
  /** Durable secret reference for the credential. */
  credentialRef?: SecretRef;
  label: string; // "user@gmail.com", "sk-ant-...1234"
  authType: "oauth" | "device-code" | "api-key";
  metadata?: {
    email?: string;
    expiresAt?: number;
    /** Runtime-only resolved refresh token value. Never persisted. */
    refreshToken?: string;
    /** Durable secret reference for the refresh token. */
    refreshTokenRef?: SecretRef;
    accountId?: string;
  };
  createdAt: number;
}

/** True if the profile has any credential source (resolved or ref). */
export function hasCredentialSource(profile: AuthProfile): boolean {
  return Boolean(profile.credential || profile.credentialRef);
}

/**
 * Declared provider credential — a credential that ships with the agent's
 * declared configuration (`lobu.config.ts` or SDK `GatewayConfig.agents`).
 *
 * Declared credentials are read-only at runtime. They are merged into the
 * effective auth profile list when no user-scoped profile exists for the
 * `(agentId, provider)` pair.
 */
export interface DeclaredCredential {
  provider: string;
  /** Plaintext key — present when the file/SDK supplies a value directly. */
  key?: string;
  /** Persisted secret reference — present when the file/SDK supplies a ref. */
  secretRef?: SecretRef;
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

/**
 * Per-skill thinking budget level.
 * Controls how much reasoning the model applies when executing a skill.
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface McpOAuthConfig {
  /** Authorization endpoint (user verification page for device-code flow). */
  authUrl?: string;
  /** Token endpoint. Falls back to `{origin}/oauth/token`. */
  tokenUrl?: string;
  /** Pre-registered client ID. When provided, dynamic client registration is skipped. */
  clientId?: string;
  /** Client secret for confidential clients. */
  clientSecret?: string;
  /** OAuth scopes. Falls back to `mcp:read mcp:write profile:read`. */
  scopes?: string[];
  /** Device authorization endpoint. Falls back to `{origin}/oauth/device_authorization`. */
  deviceAuthorizationUrl?: string;
  /** Dynamic client registration endpoint. Falls back to `{origin}/oauth/register`. */
  registrationUrl?: string;
  /** RFC 8707 resource indicator included in token requests. */
  resource?: string;
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
  /** True for non-user-managed runtime skills. */
  system?: boolean;
  /** Cached SKILL.md content (fetched from GitHub) */
  content?: string;
  /** When the content was last fetched (timestamp ms) */
  contentFetchedAt?: number;
  /** System packages declared by the skill (nix) */
  nixPackages?: string[];
  /** AI providers the skill requires */
  providers?: string[];
  /** Preferred model for this skill (e.g., "anthropic/claude-opus-4") */
  modelPreference?: string;
  /** Thinking level budget for this skill */
  thinkingLevel?: ThinkingLevel;
  /**
   * Guardrails declared by the skill.
   *
   * Skills may only declare `pre-tool` guardrails — the asymmetry is
   * deliberate. `input` (user message → worker) and `output` (worker text →
   * user) are agent-wide concerns: a skill can't decide for the operator
   * which messages should reach which agent or which words an agent may
   * speak. `pre-tool` is scoped to specific tool invocations, which is what
   * a skill knows about — it can reasonably say "before this tool runs,
   * apply this judge".
   *
   * Discriminated by `kind` so invalid combinations (neither / both) are
   * compile-time TS errors instead of runtime warnings:
   *   - `{ kind: "builtin", name }` — reference a registered guardrail.
   *     The optional `tools` field is ignored for builtins (built-ins
   *     decide their own input filtering); use an inline judge if you
   *     want per-tool narrowing.
   *   - `{ kind: "judge", policy, tools?, model? }` — ad-hoc LLM-judge policy;
   *     `tools` narrows the judge to specific tool names (matched against
   *     `toolName` in {@link PreToolGuardrailContext}); when absent, the
   *     guardrail runs on every pre-tool invocation. `model` pins the judge
   *     model; when omitted it uses the gateway default (`EGRESS_JUDGE_MODEL`),
   *     and with neither set the judge fails closed.
   */
  guardrails?: {
    "pre-tool"?: Array<SkillPreToolGuardrail>;
  };
}

/**
 * Discriminated union of legal skill-declared pre-tool guardrail entries.
 * Each entry must be either a built-in reference or an inline judge --
 * setting both, or neither, is rejected by the type checker.
 */
export type SkillPreToolGuardrail =
  | { kind: "builtin"; name: string }
  | { kind: "judge"; policy: string; tools?: string[]; model?: string };

/**
 * An operator-authored custom guardrail stored on an agent (`AgentSettings.
 * guardrailsInline`). Unlike skill-declared guardrails (pre-tool only), the
 * operator owns the agent so a custom guardrail may run at any stage. Each one
 * is an inline LLM judge: the `policy` is evaluated by `model` (defaulting to
 * the judge default) and trips when the judge denies.
 *
 * `name` is operator-given and must be unique across the agent's guardrails
 * (built-ins included) — it's the catalog id, the detail route key, and the
 * name recorded on every `guardrail-trip` event, so it has to be stable and
 * collision-free or the aggregator's name-keyed dedup would silently drop it.
 */
export interface AgentInlineGuardrail {
  name: string;
  /** When false the guardrail is kept but not resolved into the run. */
  enabled: boolean;
  stage: GuardrailStage;
  /** The judge policy prompt. */
  policy: string;
  /** Optional model override; defaults to the gateway's judge default. */
  model?: string;
  /** `pre-tool` only: narrow to specific tool names (empty = every tool). */
  tools?: string[];
  /**
   * `egress` only: hostnames this judge gates (exact or `.wildcard`), mirroring
   * `tools` for pre-tool. Empty/omitted = no egress routing.
   */
  domains?: string[];
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
 * - ".example.com" - canonical wildcard form (matches root + subdomains)
 * - "*.example.com" - accepted as input and normalized to ".example.com"
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

  /**
   * How MCP tools are exposed to the agent.
   * - "tools" (default): each MCP tool is registered as a first-class
   *   function-call tool with its JSON Schema.
   * - "cli": MCP servers are exposed as one `just-bash` command per server
   *   (e.g. `lobu search_memory <<<'{...}'`). Keeps the first-class
   *   tool list small; relies on the sandboxed bash to invoke MCP tools.
   */
  mcpExposure?: "tools" | "cli";
}

interface MemoryFlushOptions {
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

/**
 * Context information passed to instruction providers
 */
export interface InstructionContext {
  userId: string;
  agentId: string;
  /**
   * Owning org of the agent. An agent id can exist in multiple orgs (PK is
   * `(organization_id, id)`), so instruction providers must scope their
   * settings reads by org — the worker-dispatch path has no ambient orgContext,
   * so an unscoped read returns an arbitrary org's row.
   */
  organizationId?: string;
  /**
   * Whether agent-scoped settings reads are org-safe for this turn. False for an
   * orgless DB-backed agent (a shared id like "lobu-builder" exists in every
   * org, so an id-only read would leak another tenant's identity/soul/skills).
   * When false, instruction providers MUST skip the by-id settings read and use
   * their generic (no-agent) branch. True (or absent) for a normal org-scoped
   * agent and for declared/SDK-embedded agents (whose settings are org-agnostic).
   */
  orgScoped?: boolean;
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
  /**
   * Full final assistant text, set on the TERMINAL completion row by the
   * worker. Lets a renderer deliver the reply without the per-pod streaming
   * buffer (which only exists on the pod that consumed the delta rows) — so a
   * post-once platform (Slack) renders correctly even when the completion is
   * drained by a different replica than the one that buffered the deltas.
   */
  finalText?: string;
  /**
   * Raw error message. For provider errors this is relayed verbatim as the
   * user-facing body (the provider's own text already says the useful thing,
   * e.g. the quota reset time); `errorCode` only selects the CTA link.
   */
  error?: string;
  errorCode?: string;
  timestamp: number;
  originalMessageId?: string;
  botResponseId?: string;
  ephemeral?: boolean; // If true, message should be sent as ephemeral (only visible to user)
  platformMetadata?: Record<string, unknown>;
  statusUpdate?: {
    elapsedSeconds: number;
    state: string; // e.g., "is running" or "is scheduling"
  };
  customEvent?: {
    name: string;
    data: Record<string, unknown>;
    /**
     * When true, this customEvent is an interaction card (ask_user question,
     * tool-approval, link-button) that must reach the browser's SSE socket,
     * which lives on exactly one pod. The thread_response consumer treats such
     * rows like terminal API rows: a pod that does not hold the SSE connection
     * re-queues so the owning pod (pinned by ClientIP affinity) delivers it.
     * Without this the card is broadcast into a pod-local SseManager the
     * browser is not connected to and the user never sees it, hanging the turn.
     */
    requireSseOwner?: boolean;
  };

  // Exec-specific response fields (for jobType === "exec")
  execId?: string; // Exec job ID for response routing
  execStream?: "stdout" | "stderr"; // Which stream this delta is from
  execExitCode?: number; // Process exit code (sent on completion)
}

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
