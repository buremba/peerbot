import { randomBytes } from "node:crypto";
import { createLogger, type Logger } from "@lobu/core";
import { getDb } from "../../../db/client.js";

/**
 * Generic OAuth state store for CSRF protection.
 *
 * Backed by `public.oauth_states`. Each scope (e.g. `claude:oauth_state`,
 * `slack:oauth:state`) is stamped on the row so a single table can hold every
 * flow's nonces; the unique 32-byte token is the row id.
 *
 * Tokens default to a 5-minute TTL, overridable per-instance via the
 * constructor `ttlSeconds` option (e.g. the GitHub App install flow, which a
 * human + OAuth + repo-select round-trip can exceed at 5 min). Reads are lazy:
 * an expired row is filtered by `expires_at > now()` and best-effort deleted on
 * the same SELECT. The periodic `sweep-ephemeral-tables` task (registered with
 * TaskScheduler in `scheduled/jobs.ts`) deletes any leftover rows older than the
 * window.
 */
export class OAuthStateStore<T extends object> {
  /** Default TTL when a store doesn't override it. */
  private static readonly DEFAULT_TTL_SECONDS = 5 * 60; // 5 minutes
  protected logger: Logger;
  private readonly ttlSeconds: number;

  constructor(
    private keyPrefix: string,
    loggerName: string,
    options?: { ttlSeconds?: number }
  ) {
    this.logger = createLogger(loggerName);
    this.ttlSeconds = options?.ttlSeconds ?? OAuthStateStore.DEFAULT_TTL_SECONDS;
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
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);

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
   * Read the state payload without consuming it. Used when the caller needs
   * to validate side-channel context (e.g. that the callback session's org
   * matches the state's org) before atomically burning the install link —
   * without this, any failed-validation hit would force the user to restart
   * the OAuth flow even though the state is still otherwise valid.
   *
   * The row is left intact; callers must call `consume()` themselves once
   * validation passes (or rely on the TTL sweep if validation fails).
   */
  async peek(state: string): Promise<(T & { createdAt: number }) | null> {
    const sql = getDb();
    const rows = await sql`
      SELECT payload FROM oauth_states
      WHERE id = ${state}
        AND scope = ${this.keyPrefix}
        AND expires_at > now()
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return (rows[0] as { payload: T & { createdAt: number } }).payload;
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
  /**
   * Active org of the session that initiated the install. The callback
   * verifies the callback-side session's active org matches; mismatch
   * rejects the install so an OAuth link minted under org A's session can
   * never plant a connection into org B.
   */
  organizationId: string;
}

export function createSlackInstallStateStore(): OAuthStateStore<SlackInstallStateData> {
  return new OAuthStateStore("slack:oauth:state", "slack-install-state");
}

interface GithubInstallStateData {
  /**
   * Active org of the session that initiated the GitHub App install. The
   * install callback verifies a valid, unexpired state row exists and binds
   * the resulting `app_installations` row + connection to THIS org — never the
   * ambient callback-session org. Without it, a public GET to the callback
   * could plant a connection into a victim's org (CSRF / cross-tenant).
   */
  organizationId: string;
  /**
   * Set when the start route detected the App is ALREADY installed for the user
   * and routed through GitHub's user-authorization OAuth flow (recovery) rather
   * than the fresh install page. GitHub's user-auth redirect does NOT carry an
   * `installation_id` query param, so the callback derives it from
   * `GET /user/installations` (the same ownership lookup) when this flag is set.
   * Recovery never relaxes any guard — the derived installation still passes the
   * full ownership + session-org checks.
   */
  recovery?: boolean;
}

/**
 * The GitHub App install-state store. A human completing GitHub's install +
 * repo-select + OAuth round-trip routinely exceeds the default 5-minute OAuth
 * TTL (a live install failed `invalid_state` at 5m24s), so this flow gets a
 * 30-minute window. The longer TTL only widens the replay window for a
 * single-use, cryptographically-random nonce that is still consumed on first
 * use and ownership-checked before any mutation — no new exposure.
 */
const GITHUB_INSTALL_STATE_TTL_SECONDS = 30 * 60; // 30 minutes

export function createGithubInstallStateStore(): OAuthStateStore<GithubInstallStateData> {
  return new OAuthStateStore("github:app_install:state", "github-install-state", {
    ttlSeconds: GITHUB_INSTALL_STATE_TTL_SECONDS,
  });
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
