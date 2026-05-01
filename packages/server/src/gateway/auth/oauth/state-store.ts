import { randomBytes } from "node:crypto";
import { createLogger, type Logger } from "@lobu/core";
import { getDb } from "../../../db/client.js";

/**
 * Generic OAuth state store for CSRF protection.
 *
 * Backed by `public.oauth_states`. Each scope (e.g. `claude:oauth_state`,
 * `slack:oauth:state`, `mcp-oauth:state`) is stamped on the row so a single
 * table can hold every flow's nonces; the unique 32-byte token is the row id.
 *
 * Tokens have a 5-minute TTL. Reads are lazy: an expired row is filtered by
 * `expires_at > now()` and best-effort deleted on the same SELECT. The
 * periodic `sweep-ephemeral-tables` task (registered with TaskScheduler in
 * `scheduled/jobs.ts`) deletes any leftover rows older than the window.
 */
export class OAuthStateStore<T extends object> {
  private static readonly TTL_SECONDS = 5 * 60; // 5 minutes
  protected logger: Logger;

  constructor(
    private keyPrefix: string,
    loggerName: string
  ) {
    this.logger = createLogger(loggerName);
  }

  /**
   * Create a new OAuth state with data. Returns the state token.
   */
  async create(data: T): Promise<string> {
    const state = this.generateState();
    const stateData = {
      ...data,
      createdAt: Date.now(),
    };
    const sql = getDb();
    const expiresAt = new Date(
      Date.now() + OAuthStateStore.TTL_SECONDS * 1000
    );

    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (
        ${state}, ${this.keyPrefix}, ${sql.json(stateData)}, ${expiresAt}
      )
    `;

    const userId =
      typeof (data as { userId?: unknown }).userId === "string"
        ? (data as { userId: string }).userId
        : undefined;
    this.logger.info(
      userId ? `Created OAuth state for user ${userId}` : "Created OAuth state",
      { state }
    );
    return state;
  }

  /**
   * Validate and consume an OAuth state. Returns the data if valid, null
   * if invalid or expired. The row is deleted as part of the consume so a
   * replay of the same state hits the empty-row branch.
   */
  async consume(state: string): Promise<(T & { createdAt: number }) | null> {
    const sql = getDb();
    const rows = await sql`
      DELETE FROM oauth_states
      WHERE id = ${state}
        AND scope = ${this.keyPrefix}
        AND expires_at > now()
      RETURNING payload
    `;

    if (rows.length === 0) {
      this.logger.warn(`Invalid or expired OAuth state: ${state}`);
      return null;
    }

    const stateData = (rows[0] as { payload: T & { createdAt: number } })
      .payload;
    const stateDataWithUser = stateData as unknown as { userId?: unknown };
    const userId =
      typeof stateDataWithUser.userId === "string"
        ? stateDataWithUser.userId
        : undefined;
    this.logger.info(
      userId
        ? `Consumed OAuth state for user ${userId}`
        : "Consumed OAuth state",
      { state }
    );
    return stateData;
  }

  /**
   * Generate a cryptographically secure random state string.
   */
  private generateState(): string {
    return randomBytes(32).toString("base64url");
  }
}

// ============================================================================
// Provider OAuth State Types and Factory
// ============================================================================

/**
 * Context for routing auth completion back to the originating platform.
 */
export interface OAuthPlatformContext {
  platform: string;
  channelId: string; // chatJid for WhatsApp, channel for Slack
  conversationId?: string;
}

export interface ProviderOAuthStateData {
  userId: string;
  agentId: string;
  codeVerifier: string;
  context?: OAuthPlatformContext;
}

/**
 * Create a provider OAuth state store for PKCE flow.
 */
export function createOAuthStateStore(
  providerId: string
): OAuthStateStore<ProviderOAuthStateData> {
  return new OAuthStateStore(
    `${providerId}:oauth_state`,
    `${providerId}-oauth-state`
  );
}

interface SlackInstallStateData {
  redirectUri: string;
}

export function createSlackInstallStateStore(): OAuthStateStore<SlackInstallStateData> {
  return new OAuthStateStore("slack:oauth:state", "slack-install-state");
}

export type ProviderOAuthStateStore = OAuthStateStore<ProviderOAuthStateData>;

/**
 * Sweep expired oauth_states rows. Cheap because it uses the partial
 * expires_at index; safe to call from a periodic background timer.
 */
export async function sweepExpiredOAuthStates(): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM oauth_states WHERE expires_at <= now() RETURNING id
    )
    SELECT count(*)::int AS count FROM deleted
  `;
  return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}
