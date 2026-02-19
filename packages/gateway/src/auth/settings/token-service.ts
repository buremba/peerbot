import { createLogger, decrypt, encrypt } from "@lobu/core";

const logger = createLogger("settings-token-service");

/**
 * Pre-filled skill configuration for settings page
 */
export interface PrefillSkill {
  /** Skill repository (e.g., "anthropics/skills/pdf") */
  repo: string;
  /** Display name */
  name?: string;
  /** Description */
  description?: string;
}

/**
 * Pre-filled MCP server configuration for settings page
 */
export interface PrefillMcpServer {
  /** MCP server ID (key in mcpServers record) */
  id: string;
  /** Display name/description */
  name?: string;
  /** Server URL (for SSE type) */
  url?: string;
  /** Server type */
  type?: "sse" | "stdio";
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
export interface SettingsSourceContext {
  conversationId: string;
  channelId: string;
  teamId?: string;
  platform?: string;
}

/**
 * Payload stored in the settings token
 */
export interface SettingsTokenPayload {
  agentId: string;
  userId: string;
  platform: string;
  exp: number; // Expiration timestamp (ms)
  /** Optional message to display on the settings page (e.g., instructions to get an API key) */
  message?: string;
  /** Optional env vars to pre-fill in the settings page (just the keys, user fills values) */
  prefillEnvVars?: string[];
  /** Optional skills to pre-fill (user confirms to enable) */
  prefillSkills?: PrefillSkill[];
  /** Optional MCP servers to pre-fill (user confirms to enable) */
  prefillMcpServers?: PrefillMcpServer[];
  /** Optional Nix packages to pre-fill in the system packages section */
  prefillNixPackages?: string[];
  /** Optional source context for post-install notifications */
  sourceContext?: SettingsSourceContext;
}

/**
 * Default TTL for settings tokens (1 hour)
 */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Options for generating settings tokens
 */
export interface SettingsTokenOptions {
  /** TTL in milliseconds (default: 1 hour) */
  ttlMs?: number;
  /** Optional message to display on the settings page */
  message?: string;
  /** Optional env var keys to pre-fill (user fills the values) */
  prefillEnvVars?: string[];
  /** Optional skills to pre-fill (user confirms to enable) */
  prefillSkills?: PrefillSkill[];
  /** Optional MCP servers to pre-fill (user confirms to enable) */
  prefillMcpServers?: PrefillMcpServer[];
  /** Optional Nix packages to pre-fill in system packages section */
  prefillNixPackages?: string[];
  /** Optional source context for post-install notifications */
  sourceContext?: SettingsSourceContext;
}

/**
 * Generate a magic link token for accessing settings page
 *
 * Token is encrypted using AES-256-GCM and contains:
 * - agentId: The agent to configure
 * - userId: The user requesting access
 * - platform: The platform (slack/whatsapp)
 * - exp: Expiration timestamp
 * - message: Optional instructions to display
 * - prefillEnvVars: Optional env var keys to pre-fill
 * - prefillSkills: Optional skills to pre-fill
 * - prefillMcpServers: Optional MCP servers to pre-fill
 */
export function generateSettingsToken(
  agentId: string,
  userId: string,
  platform: string,
  options: SettingsTokenOptions | number = DEFAULT_TOKEN_TTL_MS
): string {
  // Handle backwards compatibility: if options is a number, treat as ttlMs
  const opts: SettingsTokenOptions =
    typeof options === "number" ? { ttlMs: options } : options;
  const ttlMs = opts.ttlMs ?? DEFAULT_TOKEN_TTL_MS;

  const payload: SettingsTokenPayload = {
    agentId,
    userId,
    platform,
    exp: Date.now() + ttlMs,
    ...(opts.message && { message: opts.message }),
    ...(opts.prefillEnvVars?.length && { prefillEnvVars: opts.prefillEnvVars }),
    ...(opts.prefillSkills?.length && { prefillSkills: opts.prefillSkills }),
    ...(opts.prefillMcpServers?.length && {
      prefillMcpServers: opts.prefillMcpServers,
    }),
    ...(opts.prefillNixPackages?.length && {
      prefillNixPackages: opts.prefillNixPackages,
    }),
    ...(opts.sourceContext && { sourceContext: opts.sourceContext }),
  };

  const encrypted = encrypt(JSON.stringify(payload));
  logger.info(`Generated settings token for agent ${agentId}, user ${userId}`);
  return encrypted;
}

/**
 * Verify and decode a settings token
 *
 * Returns the payload if valid and not expired, null otherwise.
 * Logs warnings for invalid or expired tokens.
 */
export function verifySettingsToken(
  token: string
): SettingsTokenPayload | null {
  try {
    const decrypted = decrypt(token);
    const payload = JSON.parse(decrypted) as SettingsTokenPayload;

    // Validate required fields
    if (
      !payload.agentId ||
      !payload.userId ||
      !payload.platform ||
      !payload.exp
    ) {
      logger.warn("Invalid settings token: missing required fields");
      return null;
    }

    // Check expiration
    if (Date.now() > payload.exp) {
      logger.warn(`Settings token expired for agent ${payload.agentId}`);
      return null;
    }

    logger.debug(`Verified settings token for agent ${payload.agentId}`);
    return payload;
  } catch (error) {
    logger.warn("Failed to verify settings token", { error });
    return null;
  }
}

/**
 * Build the full settings URL with token
 */
export function buildSettingsUrl(token: string): string {
  const baseUrl = process.env.PUBLIC_GATEWAY_URL || "http://localhost:8080";
  // URL-encode the token since it contains special characters
  return `${baseUrl}/settings?token=${encodeURIComponent(token)}`;
}
