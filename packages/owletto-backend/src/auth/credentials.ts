/**
 * Credential Management Service
 *
 * Handles linking OAuth accounts to connectors and managing credentials for source authentication.
 */

import type { DbClient } from '../db/client';
import type { Env } from '../index';
import {
  getEnabledLoginProviderConfigs,
  resolveDefaultOrganizationId,
  resolveLoginProviderCredentials,
} from './config';

/**
 * User credential with account info
 */
export interface UserCredential {
  id: number;
  userId: string;
  accountId: string;
  connectorKeys: string[];
  displayName: string;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  // From joined account table
  providerId: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  accessTokenExpiresAt: Date | null;
}

/**
 * Credential tokens for sync execution
 */
export interface CredentialTokens {
  provider: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

/**
 * Credential Management Service
 */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function isTokenExpiringSoon(expiresAt: Date | string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now() + TOKEN_EXPIRY_BUFFER_MS;
}

const USER_CREDENTIAL_SELECT = `
  uc.id,
  uc.user_id as "userId",
  uc.account_id as "accountId",
  uc.crawler_types as "connectorKeys",
  uc.display_name as "displayName",
  uc.is_active as "isActive",
  uc.last_used_at as "lastUsedAt",
  uc.created_at as "createdAt",
  a."providerId",
  a."accessToken" IS NOT NULL as "hasAccessToken",
  a."refreshToken" IS NOT NULL as "hasRefreshToken",
  a."accessTokenExpiresAt"
` as const;

export class CredentialService {
  constructor(private sql: DbClient) {}

  /**
   * List user's credentials with account info
   */
  async getUserCredentials(userId: string): Promise<UserCredential[]> {
    const result = await this.sql`
      SELECT ${this.sql.unsafe(USER_CREDENTIAL_SELECT)}
      FROM user_credentials uc
      JOIN "account" a ON uc.account_id = a.id
      WHERE uc.user_id = ${userId}
      ORDER BY uc.created_at DESC
    `;
    return result as unknown as UserCredential[];
  }

  /**
   * List active credentials for a connector + provider pair.
   */
  async listCredentialsForConnector(
    userId: string,
    connectorKey: string,
    provider: string
  ): Promise<UserCredential[]> {
    const normalizedConnectorKey = connectorKey.toLowerCase();
    const normalizedProvider = provider.toLowerCase();
    const result = await this.sql`
      SELECT ${this.sql.unsafe(USER_CREDENTIAL_SELECT)}
      FROM user_credentials uc
      JOIN "account" a ON uc.account_id = a.id
      WHERE uc.user_id = ${userId}
        AND uc.is_active = TRUE
        AND LOWER(a."providerId") = ${normalizedProvider}
        AND (
          array_length(uc.crawler_types, 1) IS NULL
          OR ${normalizedConnectorKey} = ANY(uc.crawler_types)
        )
      ORDER BY uc.last_used_at DESC NULLS LAST, uc.created_at DESC
    `;
    return result as unknown as UserCredential[];
  }

  /**
   * Get user's linked OAuth accounts (from better-auth)
   */
  async getUserAccounts(userId: string) {
    const result = await this.sql`
      SELECT
        id,
        "accountId",
        "providerId",
        "accessToken" IS NOT NULL as "hasAccessToken",
        "refreshToken" IS NOT NULL as "hasRefreshToken",
        "accessTokenExpiresAt",
        scope,
        "createdAt"
      FROM "account"
      WHERE "userId" = ${userId}
      ORDER BY "createdAt" DESC
    `;
    return result;
  }

  /**
   * Find the preferred credential for a connector/provider in the current org.
   * Preference order:
   * 1) Credential previously linked to a connection of same connector key in this org
   * 2) Most recently used active credential for this connector/provider
   */
  async resolvePreferredCredentialForConnector(params: {
    userId: string;
    organizationId: string;
    connectorKey: string;
    provider: string;
  }): Promise<UserCredential | null> {
    const normalizedConnectorKey = params.connectorKey.toLowerCase();
    const normalizedProvider = params.provider.toLowerCase();

    const linkedResult = await this.sql`
      SELECT ${this.sql.unsafe(USER_CREDENTIAL_SELECT)}
      FROM connections c
      JOIN auth_profiles ap ON ap.id = c.auth_profile_id
      JOIN user_credentials uc ON uc.account_id = ap.account_id
      JOIN "account" a ON a.id = ap.account_id
      WHERE uc.user_id = ${params.userId}
        AND uc.is_active = TRUE
        AND c.organization_id = ${params.organizationId}
        AND LOWER(c.connector_key) = ${normalizedConnectorKey}
        AND LOWER(a."providerId") = ${normalizedProvider}
        AND c.deleted_at IS NULL
      ORDER BY uc.last_used_at DESC NULLS LAST, c.updated_at DESC
      LIMIT 1
    `;

    if (linkedResult.length > 0) {
      return linkedResult[0] as unknown as UserCredential;
    }

    const available = await this.listCredentialsForConnector(
      params.userId,
      normalizedConnectorKey,
      normalizedProvider
    );
    return available.length > 0 ? available[0] : null;
  }

  /**
   * Ensure there is an active credential for one of the user's linked OAuth accounts.
   * If account is linked but credential row does not exist, this will create one.
   */
  async ensureCredentialFromLinkedAccount(
    userId: string,
    provider: string,
    connectorKey: string
  ): Promise<UserCredential | null> {
    const normalizedProvider = provider.toLowerCase();
    const normalizedConnectorKey = connectorKey.toLowerCase();

    const existing = await this.listCredentialsForConnector(
      userId,
      normalizedConnectorKey,
      normalizedProvider
    );
    if (existing.length > 0) {
      return existing[0];
    }

    const accountRows = await this.sql`
      SELECT
        id,
        "providerId",
        "accountId",
        "createdAt"
      FROM "account"
      WHERE "userId" = ${userId}
        AND LOWER("providerId") = ${normalizedProvider}
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    if (accountRows.length === 0) {
      return null;
    }

    const account = accountRows[0] as {
      id: string;
      providerId: string;
      accountId: string | null;
    };
    const fallbackName = account.accountId?.trim() || account.id.slice(0, 8);
    const displayName = `${account.providerId} ${fallbackName}`.trim();

    const upserted = await this.sql`
      INSERT INTO user_credentials (user_id, account_id, crawler_types, display_name, is_active)
      VALUES (${userId}, ${account.id}, ${[normalizedConnectorKey]}, ${displayName}, TRUE)
      ON CONFLICT (user_id, account_id)
      DO UPDATE SET
        crawler_types = (
          SELECT ARRAY(
            SELECT DISTINCT x
            FROM unnest(COALESCE(user_credentials.crawler_types, '{}') || EXCLUDED.crawler_types) AS t(x)
          )
        ),
        is_active = TRUE,
        updated_at = NOW()
      RETURNING id
    `;

    const credentialId = Number((upserted[0] as { id: number }).id);
    const allCredentials = await this.getUserCredentials(userId);
    return allCredentials.find((credential) => credential.id === credentialId) ?? null;
  }

  /**
   * Create a credential from an OAuth account
   */
  async createCredentialFromAccount(
    userId: string,
    accountId: string,
    connectorKeys: string[],
    displayName: string
  ): Promise<UserCredential> {
    // Verify account belongs to user
    const account = await this.sql`
      SELECT id, "providerId" FROM "account"
      WHERE id = ${accountId} AND "userId" = ${userId}
    `;

    if (account.length === 0) {
      throw new Error('Account not found or does not belong to user');
    }

    const result = await this.sql`
      INSERT INTO user_credentials (user_id, account_id, crawler_types, display_name)
      VALUES (${userId}, ${accountId}, ${connectorKeys}, ${displayName})
      ON CONFLICT (user_id, account_id)
      DO UPDATE SET
        crawler_types = EXCLUDED.crawler_types,
        display_name = EXCLUDED.display_name,
        updated_at = NOW()
      RETURNING *
    `;

    // Return with full credential info
    const credentials = await this.getUserCredentials(userId);
    const credential = credentials.find((c) => c.id === result[0].id);
    if (!credential) {
      throw new Error('Credential lookup failed after upsert');
    }
    return credential;
  }

  /**
   * Update credential's connector keys
   */
  async updateCredentialConnectorKeys(
    credentialId: number,
    userId: string,
    connectorKeys: string[]
  ): Promise<void> {
    const result = await this.sql`
      UPDATE user_credentials
      SET crawler_types = ${connectorKeys}, updated_at = NOW()
      WHERE id = ${credentialId} AND user_id = ${userId}
    `;

    if (result.count === 0) {
      throw new Error('Credential not found or does not belong to user');
    }
  }

  /**
   * Deactivate a credential
   */
  async deactivateCredential(credentialId: number, userId: string): Promise<void> {
    await this.sql`
      UPDATE user_credentials
      SET is_active = false, updated_at = NOW()
      WHERE id = ${credentialId} AND user_id = ${userId}
    `;
  }

  /**
   * Delete a credential (will fail if sources are linked)
   */
  async deleteCredential(credentialId: number, userId: string): Promise<void> {
    const result = await this.sql`
      DELETE FROM user_credentials
      WHERE id = ${credentialId} AND user_id = ${userId}
    `;

    if (result.count === 0) {
      throw new Error('Credential not found or does not belong to user');
    }
  }

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
      if (isTokenExpiringSoon(tokens.expiresAt) && tokens.refreshToken) {
        let newTokens: { accessToken: string; expiresAt: Date; refreshToken?: string } | null =
          null;

        if (oauthConfig) {
          // Use generic refresh with provided OAuth config
          newTokens = await this.refreshTokenGeneric({
            ...oauthConfig,
            refreshToken: tokens.refreshToken,
          });
        }
        // Note: without oauthConfig, non-generic refresh is handled by
        // refreshTokenIfNeeded() which has access to Env.

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
   * Refresh OAuth token if expired
   * Returns true if token is valid (either still valid or successfully refreshed)
   */
  async refreshTokenIfNeeded(credentialId: number, env: Env): Promise<boolean> {
    const credential = await this.sql`
      SELECT
        uc.id,
        a."providerId",
        a."refreshToken",
        a."accessTokenExpiresAt"
      FROM user_credentials uc
      JOIN "account" a ON uc.account_id = a.id
      WHERE uc.id = ${credentialId}
    `;

    if (credential.length === 0 || !credential[0].refreshToken) {
      return false;
    }

    if (!isTokenExpiringSoon(credential[0].accessTokenExpiresAt)) {
      return true;
    }

    const newTokens = await this.refreshOAuthToken(
      credential[0].providerId,
      credential[0].refreshToken,
      env
    );

    if (!newTokens) return false;

    // Update tokens in database
    await this.sql`
      UPDATE "account"
      SET
        "accessToken" = ${newTokens.accessToken},
        "accessTokenExpiresAt" = ${newTokens.expiresAt},
        "updatedAt" = NOW()
      WHERE id = (
        SELECT account_id FROM user_credentials WHERE id = ${credentialId}
      )
    `;

    // Update last_refresh_at
    await this.sql`
      UPDATE user_credentials
      SET last_refresh_at = NOW()
      WHERE id = ${credentialId}
    `;

    return true;
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

  private async refreshOAuthToken(
    provider: string,
    refreshToken: string,
    env: Env
  ): Promise<{ accessToken: string; expiresAt: Date } | null> {
    const normalizedProvider = provider.toLowerCase();
    const organizationId = await resolveDefaultOrganizationId();
    const configs = await getEnabledLoginProviderConfigs(organizationId);
    const config = configs.find((c) => c.provider === normalizedProvider);

    if (!config) {
      console.warn(
        `[Credentials] No login-enabled connector found for provider '${provider}'; cannot refresh token.`
      );
      return null;
    }

    if (!config.tokenUrl) {
      console.warn(
        `[Credentials] Connector '${config.connectorKey}' for provider '${provider}' ` +
          `does not declare 'tokenUrl'; cannot refresh token.`
      );
      return null;
    }

    const { clientId, clientSecret } = await resolveLoginProviderCredentials({
      env,
      provider: normalizedProvider,
      connectorKey: config.connectorKey,
      clientIdKey: config.clientIdKey,
      clientSecretKey: config.clientSecretKey,
      organizationId,
    });

    if (!clientId) {
      console.warn(`[Credentials] Missing OAuth client credentials for provider '${provider}'.`);
      return null;
    }

    const newTokens = await this.refreshTokenGeneric({
      tokenUrl: config.tokenUrl,
      clientId,
      clientSecret: clientSecret ?? undefined,
      refreshToken,
      authMethod: config.tokenEndpointAuthMethod,
    });

    if (!newTokens) return null;

    return { accessToken: newTokens.accessToken, expiresAt: newTokens.expiresAt };
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
}
