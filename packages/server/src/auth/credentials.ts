/**
 * Credential Service — OAuth token resolution and refresh
 *
 * Used by execution-context.ts and mcp-proxy/credential-resolver.ts to
 * resolve and auto-refresh OAuth tokens for upstream API calls.
 */

import type { DbClient } from '../db/client';
import { buildRefreshRequest, parseTokenRefreshResponse } from './oauth/token-refresh';

/**
 * Credential tokens for sync execution
 */
interface CredentialTokens {
  provider: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function isTokenExpiringSoon(expiresAt: Date | string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now() + TOKEN_EXPIRY_BUFFER_MS;
}

/**
 * Per-account advisory-lock tag. `pg_advisory_xact_lock(hashtext($1))` keys the
 * lock off this string and auto-releases at transaction end, serializing OAuth
 * token refresh across replicas so two workers can't both rotate the same
 * account's refresh token and clobber each other's result.
 */
function refreshLockTag(accountId: string): string {
  return `oauth_account_refresh:${accountId}`;
}

export class CredentialService {
  constructor(private sql: DbClient) {}

  /**
   * Get OAuth tokens for a connection (V1 integration platform).
   * Reads from auth_profiles.account_id -> account table.
   * Optionally accepts oauthConfig for generic token refresh (non-Google providers).
   */
  async getConnectionTokens(
    _connectionId: number,
    accountId: string,
    oauthConfig?: {
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
    }
  ): Promise<CredentialTokens | null> {
    const result = await this.sql`
      SELECT
        a."providerId" as provider,
        a."accessToken" as "accessToken",
        a."refreshToken" as "refreshToken",
        a."accessTokenExpiresAt" as "expiresAt",
        a.scope
      FROM "account" a
      WHERE a.id = ${accountId}
    `;

    if (result.length === 0) return null;

    const tokens = result[0] as unknown as CredentialTokens;

    // Check if token needs refresh
    if (tokens.expiresAt) {
      if (isTokenExpiringSoon(tokens.expiresAt) && tokens.refreshToken && oauthConfig) {
        const newTokens = await this.refreshAccountUnderLock(accountId, oauthConfig);
        if (newTokens) {
          return {
            ...tokens,
            accessToken: newTokens.accessToken,
            expiresAt: newTokens.expiresAt,
          };
        }
      }
    }

    return tokens;
  }

  /**
   * Public method for refreshing tokens with explicit OAuth config.
   * Used by the MCP proxy to refresh tokens using connector-specific OAuth settings.
   *
   * Serialized per account under a Postgres advisory lock with the stored
   * refresh token re-read inside the lock — so concurrent refreshes across
   * replicas can't both rotate and clobber each other's persisted token.
   */
  async refreshWithConfig(config: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
    accountId: string;
  }): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string } | null> {
    return this.refreshAccountUnderLock(config.accountId, {
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authMethod: config.authMethod,
    });
  }

  /**
   * Refresh + persist an account's OAuth token under a per-account Postgres
   * advisory lock. The lock is held for the whole transaction; the stored
   * refresh token and expiry are RE-READ inside the lock so that if a
   * concurrent refresh (this pod or another replica) already rotated the
   * token, the loser uses the freshly-stored refresh token / no-ops on a
   * still-valid expiry instead of replaying a rotated-away token.
   */
  private async refreshAccountUnderLock(
    accountId: string,
    oauthConfig: {
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
    }
  ): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string } | null> {
    return this.sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        refreshLockTag(accountId),
      ]);

      // Re-read under the lock: a concurrent refresh may have rotated the
      // refresh token and pushed the expiry out while we waited to acquire it.
      const rows = await tx`
        SELECT
          a."accessToken" as "accessToken",
          a."refreshToken" as "refreshToken",
          a."accessTokenExpiresAt" as "expiresAt"
        FROM "account" a
        WHERE a.id = ${accountId}
        FOR UPDATE
      `;
      const current = rows[0] as
        | { accessToken: string | null; refreshToken: string | null; expiresAt: Date | null }
        | undefined;
      if (!current?.refreshToken) return null;

      // If the token is no longer expiring soon, another worker just rotated
      // it — return the now-current credentials instead of refreshing again.
      if (current.expiresAt && !isTokenExpiringSoon(current.expiresAt)) {
        return current.accessToken
          ? { accessToken: current.accessToken, expiresAt: new Date(current.expiresAt) }
          : null;
      }

      const result = await this.refreshTokenGeneric({
        ...oauthConfig,
        refreshToken: current.refreshToken,
      });
      if (!result) return null;

      await this.persistAccountTokens(accountId, result, tx);
      return result;
    });
  }

  private async persistAccountTokens(
    accountId: string,
    tokens: { accessToken: string; expiresAt: Date; refreshToken?: string },
    sql: DbClient = this.sql
  ): Promise<void> {
    await sql`
      UPDATE "account"
      SET "accessToken" = ${tokens.accessToken},
          "accessTokenExpiresAt" = ${tokens.expiresAt.toISOString()},
          "refreshToken" = COALESCE(${tokens.refreshToken ?? null}, "refreshToken"),
          "updatedAt" = NOW()
      WHERE id = ${accountId}
    `;
  }

  /**
   * Generic OAuth token refresh supporting multiple auth methods.
   * Ported from Termos GenericOAuth2Client.refreshToken().
   */
  async refreshTokenGeneric(params: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  }): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string } | null> {
    const { headers, body } = buildRefreshRequest({
      profile: 'account-credential',
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      refreshToken: params.refreshToken,
      authMethod: params.authMethod,
    });

    try {
      const response = await fetch(params.tokenUrl, {
        method: 'POST',
        headers,
        body,
      });

      if (!response.ok) {
        console.error('[Credentials] Generic token refresh failed:', await response.text());
        return null;
      }

      const data = (await response.json()) as Record<string, unknown>;
      const parsed = parseTokenRefreshResponse(data);
      if (!parsed) {
        console.error('[Credentials] Generic token refresh returned no access_token');
        return null;
      }

      return {
        accessToken: parsed.accessToken,
        expiresAt: new Date(parsed.expiresAtMs),
        refreshToken: parsed.refreshToken,
      };
    } catch (error) {
      console.error('[Credentials] Generic token refresh error:', error);
      return null;
    }
  }
}
