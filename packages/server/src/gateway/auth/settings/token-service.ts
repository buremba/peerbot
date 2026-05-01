/**
 * Pre-filled skill configuration for an agent config session
 */
interface PrefillSkill {
  /** Skill repository (e.g., "anthropics/skills/pdf") */
  repo: string;
  /** Display name */
  name?: string;
  /** Description */
  description?: string;
}

/**
 * Pre-filled MCP server configuration for an agent config session
 */
interface PrefillMcpServer {
  /** MCP server ID (key in mcpServers record) */
  id: string;
  /** Display name/description */
  name?: string;
  /** Server URL (for SSE type) */
  url?: string;
  /** Server type */
  type?: "sse" | "streamable-http" | "stdio";
  /** Command (for stdio type) */
  command?: string;
  /** Args (for stdio type) */
  args?: string[];
  /** Environment variables needed (just the keys, user fills values) */
  envVars?: string[];
}

/**
 * Source message context where settings link was requested.
 * Used to send follow-up notifications back to the same conversation.
 */
interface SettingsSourceContext {
  conversationId: string;
  channelId: string;
  teamId?: string;
  platform?: string;
}

/**
 * Unified session payload for config/auth sessions.
 *
 * OAuth sessions populate email/name/oauthUserId. Claimed chat sessions
 * populate platform/channelId/userId directly.
 */
export interface SettingsTokenPayload {
  /** Agent to configure. Optional when using channel-based entry (user picks agent on page). */
  agentId?: string;
  userId: string;
  platform: string;
  exp: number; // Expiration timestamp (ms)
  /** Channel that triggered the settings link. Used for agent switching and binding. */
  channelId?: string;
  /** Team/workspace ID for multi-tenant platforms (Slack). */
  teamId?: string;
  /** OAuth user email (set for OAuth sessions). */
  email?: string;
  /** OAuth user display name (set for OAuth sessions). */
  name?: string;
  /** OAuth provider user ID (set for OAuth sessions). */
  oauthUserId?: string;
  /** Optional message to display during config/auth flows */
  message?: string;
  /** Optional provider IDs to associate with the flow */
  prefillProviders?: string[];
  /** Optional skills to pre-fill (user confirms to enable) */
  prefillSkills?: PrefillSkill[];
  /** Optional MCP servers to pre-fill (user confirms to enable) */
  prefillMcpServers?: PrefillMcpServer[];
  /** Optional Nix packages to pre-fill */
  prefillNixPackages?: string[];
  /** Optional domain patterns to pre-fill as grants */
  prefillGrants?: string[];
  /** Optional source context for post-install notifications */
  sourceContext?: SettingsSourceContext;
  /** Settings mode: "admin" has full access, "user" is restricted by allowedScopes */
  settingsMode?: "admin" | "user";
  /** Scopes the user is allowed to configure (only relevant when settingsMode is "user") */
  allowedScopes?: string[];
  /** Connection ID that triggered this session */
  connectionId?: string;
  /** Whether this session has admin access */
  isAdmin?: boolean;
}
