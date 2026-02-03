import { createLogger, decrypt, encrypt } from "@peerbot/core";

const logger = createLogger("settings-token-service");

/**
 * Payload stored in the settings token
 */
export interface SettingsTokenPayload {
  agentId: string;
  userId: string;
  platform: string;
  exp: number; // Expiration timestamp (ms)
}

/**
 * Default TTL for settings tokens (1 hour)
 */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Generate a magic link token for accessing settings page
 *
 * Token is encrypted using AES-256-GCM and contains:
 * - agentId: The agent to configure
 * - userId: The user requesting access
 * - platform: The platform (slack/whatsapp)
 * - exp: Expiration timestamp
 */
export function generateSettingsToken(
  agentId: string,
  userId: string,
  platform: string,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS
): string {
  const payload: SettingsTokenPayload = {
    agentId,
    userId,
    platform,
    exp: Date.now() + ttlMs,
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
