/**
 * Credential Service — OAuth token resolution and refresh
 *
 * Used by execution-context.ts and mcp-proxy/credential-resolver.ts to
 * resolve and auto-refresh OAuth tokens for upstream API calls.
 */

import type { DbClient } from '../db/client';

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
        const newTokens = await this.refreshTokenGeneric({
          ...oauthConfig,
          refreshToken: tokens.refreshToken,
        });

        if (newTokens) {
          await this.persistAccountTokens(accountId, newTokens);
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
   */
  async refreshWithConfig(config: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
    accountId: string;
  }): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string } | null> {
    const result = await this.refreshTokenGeneric(config);
    if (!result) return null;

    await this.persistAccountTokens(config.accountId, result);
    return result;
  }

  private async persistAccountTokens(
    accountId: string,
    tokens: { accessToken: string; expiresAt: Date; refreshToken?: string }
  ): Promise<void> {
    await this.sql`
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
    const authMethod = params.authMethod || 'client_secret_post';

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (authMethod === 'client_secret_basic') {
      headers.Authorization = `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret || ''}`).toString('base64')}`;
    } else {
      body.set('client_id', params.clientId);
      if (authMethod !== 'none' && params.clientSecret) {
        body.set('client_secret', params.clientSecret);
      }
    }

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

      const data = (await response.json()) as {
        access_token: string;
        expires_in?: number;
        refresh_token?: string;
      };

      return {
        accessToken: data.access_token,
        expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
        refreshToken: data.refresh_token,
      };
    } catch (error) {
      console.error('[Credentials] Generic token refresh error:', error);
      return null;
    }
  }
}
