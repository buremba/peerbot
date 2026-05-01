/**
 * OAuth 2.1 Server Provider
 *
 * Implements the OAuth 2.1 authorization server for MCP authentication.
 * Supports PKCE, token exchange, and refresh tokens.
 */

import type { DbClient } from '../../db/client';
import { OAuthClientsStore } from './clients';
import { AVAILABLE_SCOPES } from './scopes';
import type {
  AuthInfo,
  AuthorizationParams,
  DeviceAuthorizationResponse,
  OAuthClient,
  OAuthTokenResponse,
  StoredAuthorizationCode,
  StoredDeviceCode,
  StoredOAuthToken,
  TokenRequestParams,
} from './types';
import {
  ACCESS_TOKEN_LIFETIME_SECONDS,
  AUTHORIZATION_CODE_LIFETIME_SECONDS,
  calculateExpiry,
  createOAuthError,
  DEVICE_CODE_LIFETIME_SECONDS,
  DEVICE_CODE_POLL_INTERVAL_SECONDS,
  generateAccessToken,
  generateAuthorizationCode,
  generateDeviceCode,
  generateId,
  generateRefreshToken,
  generateUserCode,
  hashToken,
  type OAuthError,
  parseScopes,
  REFRESH_TOKEN_LIFETIME_SECONDS,
  verifyCodeChallenge,
} from './utils';

/**
 * OAuth 2.1 Server Provider
 */
export class OAuthProvider {
  public readonly clientsStore: OAuthClientsStore;

  constructor(
    private sql: DbClient,
    private baseUrl: string
  ) {
    this.clientsStore = new OAuthClientsStore(sql);
  }

  // ============================================
  // Authorization Code Flow
  // ============================================

  /**
   * Create an authorization code for a user
   *
   * Called after user authenticates and consents.
   *
   * @param params - Authorization request parameters
   * @param userId - Authenticated user ID
   * @param organizationId - User's active organization
   * @returns Authorization code
   */
  async createAuthorizationCode(
    params: AuthorizationParams,
    userId: string,
    organizationId: string | null
  ): Promise<string> {
    const code = generateAuthorizationCode();
    const expiresAt = calculateExpiry(AUTHORIZATION_CODE_LIFETIME_SECONDS);

    await this.sql`
      INSERT INTO oauth_authorization_codes (
        code, client_id, user_id, organization_id,
        code_challenge, code_challenge_method,
        redirect_uri, scope, state, resource, expires_at
      ) VALUES (
        ${code},
        ${params.client_id},
        ${userId},
        ${organizationId},
        ${params.code_challenge},
        ${params.code_challenge_method},
        ${params.redirect_uri},
        ${params.scope || null},
        ${params.state || null},
        ${params.resource || null},
        ${expiresAt}
      )
    `;

    return code;
  }

  /**
   * Exchange authorization code for tokens
   *
   * Validates PKCE and issues access/refresh tokens.
   */
  async exchangeAuthorizationCode(
    params: TokenRequestParams
  ): Promise<OAuthTokenResponse | OAuthError> {
    if (!params.code || !params.code_verifier) {
      return createOAuthError('invalid_request', 'Missing code or code_verifier');
    }

    const clientValidation = await this.validateClientTokenAuthentication(
      params.client_id,
      params.client_secret
    );
    if ('error' in clientValidation) {
      return clientValidation;
    }
    const client = clientValidation;
    if (!client.grant_types?.includes('authorization_code')) {
      return createOAuthError('unauthorized_client', 'Client does not support authorization_code');
    }

    // Atomically fetch and mark code as used to prevent replay attacks
    const codeResult = await this.sql`
      UPDATE oauth_authorization_codes
      SET used_at = NOW()
      WHERE code = ${params.code}
        AND expires_at > NOW()
        AND used_at IS NULL
      RETURNING *
    `;

    if (codeResult.length === 0) {
      return createOAuthError('invalid_grant', 'Invalid or expired authorization code');
    }

    const authCode = codeResult[0] as StoredAuthorizationCode;

    // Validate client_id matches
    if (authCode.client_id !== params.client_id) {
      return createOAuthError('invalid_grant', 'Client ID mismatch');
    }

    // Validate redirect_uri matches (RFC 6749 Section 4.1.3)
    if (authCode.redirect_uri !== params.redirect_uri) {
      return createOAuthError('invalid_grant', 'Redirect URI mismatch');
    }

    // Validate PKCE code_verifier
    if (
      !verifyCodeChallenge(
        params.code_verifier,
        authCode.code_challenge,
        authCode.code_challenge_method as 'S256' | 'plain'
      )
    ) {
      return createOAuthError('invalid_grant', 'Invalid code_verifier');
    }

    // Generate tokens
    return this.issueTokens(
      authCode.client_id,
      authCode.user_id,
      authCode.organization_id,
      authCode.scope,
      authCode.resource
    );
  }

  /**
   * Refresh access token (with token rotation)
   *
   * Implements refresh token rotation for security:
   * - Old refresh token is revoked after use
   * - New refresh token is issued with each refresh
   * - Prevents token replay attacks
   */
  async refreshAccessToken(params: TokenRequestParams): Promise<OAuthTokenResponse | OAuthError> {
    if (!params.refresh_token) {
      return createOAuthError('invalid_request', 'Missing refresh_token');
    }

    const clientValidation = await this.validateClientTokenAuthentication(
      params.client_id,
      params.client_secret
    );
    if ('error' in clientValidation) {
      return clientValidation;
    }
    const client = clientValidation;
    if (!client.grant_types?.includes('refresh_token')) {
      return createOAuthError('unauthorized_client', 'Client does not support refresh_token');
    }

    const tokenHash = hashToken(params.refresh_token);

    // Fetch and validate refresh token
    const tokenResult = await this.sql`
      SELECT * FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND token_type = 'refresh'
        AND revoked_at IS NULL
        AND expires_at > NOW()
    `;

    if (tokenResult.length === 0) {
      return createOAuthError('invalid_grant', 'Invalid or expired refresh token');
    }

    const oldRefreshToken = tokenResult[0] as StoredOAuthToken;

    // Validate client_id matches
    if (oldRefreshToken.client_id !== params.client_id) {
      return createOAuthError('invalid_grant', 'Client ID mismatch');
    }

    // Use requested scope only if it is a subset of the original grant.
    let scope = oldRefreshToken.scope;
    if (params.scope !== undefined) {
      const originalScopes = parseScopes(oldRefreshToken.scope);
      const requestedScopesRaw = params.scope.split(' ').filter(Boolean);
      const requestedScopes = parseScopes(params.scope);
      if (requestedScopesRaw.length !== requestedScopes.length) {
        return createOAuthError('invalid_scope', 'Requested scope contains unsupported values');
      }
      const originalScopeSet = new Set(originalScopes);
      const isSubset = requestedScopes.every((requestedScope) =>
        originalScopeSet.has(requestedScope)
      );
      if (!isSubset) {
        return createOAuthError(
          'invalid_scope',
          'Requested scope exceeds originally granted scope'
        );
      }
      scope = requestedScopes.join(' ');
    }

    // Generate new tokens
    const accessToken = generateAccessToken();
    const newRefreshToken = generateRefreshToken();
    const accessTokenId = generateId();
    const refreshTokenId = generateId();
    const accessExpiresAt = calculateExpiry(ACCESS_TOKEN_LIFETIME_SECONDS);
    const refreshExpiresAt = calculateExpiry(REFRESH_TOKEN_LIFETIME_SECONDS);

    // Revoke old refresh token and issue new tokens atomically
    await this.sql.begin(async (tx) => {
      await tx`
        UPDATE oauth_tokens
        SET revoked_at = NOW()
        WHERE id = ${oldRefreshToken.id}
      `;

      await tx`
        INSERT INTO oauth_tokens (
          id, token_type, token_hash,
          client_id, user_id, organization_id,
          scope, resource, parent_token_id, expires_at
        ) VALUES
          (${accessTokenId}, 'access', ${hashToken(accessToken)},
           ${oldRefreshToken.client_id}, ${oldRefreshToken.user_id}, ${oldRefreshToken.organization_id},
           ${scope}, ${params.resource || oldRefreshToken.resource}, ${refreshTokenId}, ${accessExpiresAt}),
          (${refreshTokenId}, 'refresh', ${hashToken(newRefreshToken)},
           ${oldRefreshToken.client_id}, ${oldRefreshToken.user_id}, ${oldRefreshToken.organization_id},
           ${scope}, ${params.resource || oldRefreshToken.resource}, ${oldRefreshToken.id}, ${refreshExpiresAt})
      `;
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      refresh_token: newRefreshToken,
      scope: scope || undefined,
    };
  }

  /**
   * Issue new access and refresh tokens
   */
  private async issueTokens(
    clientId: string,
    userId: string,
    organizationId: string | null,
    scope: string | null,
    resource: string | null
  ): Promise<OAuthTokenResponse> {
    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();

    const accessTokenId = generateId();
    const refreshTokenId = generateId();

    const accessExpiresAt = calculateExpiry(ACCESS_TOKEN_LIFETIME_SECONDS);
    const refreshExpiresAt = calculateExpiry(REFRESH_TOKEN_LIFETIME_SECONDS);

    // Insert both tokens
    await this.sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash,
        client_id, user_id, organization_id,
        scope, resource, expires_at
      ) VALUES
        (${accessTokenId}, 'access', ${hashToken(accessToken)},
         ${clientId}, ${userId}, ${organizationId},
         ${scope}, ${resource}, ${accessExpiresAt}),
        (${refreshTokenId}, 'refresh', ${hashToken(refreshToken)},
         ${clientId}, ${userId}, ${organizationId},
         ${scope}, ${resource}, ${refreshExpiresAt})
    `;

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      scope: scope || undefined,
    };
  }

  private async validateClientTokenAuthentication(
    clientId: string,
    clientSecret: string | undefined
  ): Promise<OAuthClient | OAuthError> {
    const client = await this.clientsStore.getClient(clientId);
    if (!client) {
      return createOAuthError('invalid_client', 'Unknown client_id');
    }

    const authMethod = client.token_endpoint_auth_method ?? 'none';
    const requiresSecret =
      authMethod === 'client_secret_post' || authMethod === 'client_secret_basic';

    if (requiresSecret && !clientSecret) {
      return createOAuthError('invalid_client', 'client_secret is required for this client');
    }

    if (clientSecret !== undefined) {
      const isValid = await this.clientsStore.verifyClientCredentials(clientId, clientSecret);
      if (!isValid) {
        return createOAuthError('invalid_client', 'Invalid client credentials');
      }
    }

    return client;
  }

  // ============================================
  // Token Verification
  // ============================================

  /**
   * Verify an access token and return auth info
   */
  async verifyAccessToken(token: string): Promise<AuthInfo | null> {
    const tokenHash = hashToken(token);

    const result = await this.sql`
      SELECT t.*, u.email, u.name as user_name
      FROM oauth_tokens t
      JOIN "user" u ON t.user_id = u.id
      WHERE t.token_hash = ${tokenHash}
        AND t.token_type = 'access'
        AND t.revoked_at IS NULL
        AND t.expires_at > NOW()
    `;

    if (result.length === 0) return null;

    const tokenData = result[0] as StoredOAuthToken & {
      email: string;
      user_name: string;
    };

    return {
      userId: tokenData.user_id,
      organizationId: tokenData.organization_id,
      clientId: tokenData.client_id,
      scopes: parseScopes(tokenData.scope),
      expiresAt: Math.floor(new Date(tokenData.expires_at).getTime() / 1000),
      resource: tokenData.resource || undefined,
      tokenType: 'access_token',
    };
  }

  // ============================================
  // User Info
  // ============================================

  /**
   * Get user info for a verified access token
   * Requires profile:read scope
   */
  async getUserInfo(token: string): Promise<{
    sub: string;
    email: string;
    name: string | null;
    organization_slug: string | null;
    organizations: { slug: string; name: string }[];
  } | null> {
    const authInfo = await this.verifyAccessToken(token);
    if (!authInfo) return null;

    if (!authInfo.scopes.includes('profile:read')) {
      return null;
    }

    const result = await this.sql`
      SELECT id, email, name FROM "user" WHERE id = ${authInfo.userId}
    `;

    if (result.length === 0) return null;

    // Return the token-bound org (if any) and the full list of orgs
    let organizationSlug: string | null = null;
    if (authInfo.organizationId) {
      const orgResult = await this.sql`
        SELECT slug FROM "organization" WHERE id = ${authInfo.organizationId} LIMIT 1
      `;
      organizationSlug = (orgResult[0]?.slug as string) ?? null;
    }

    const orgs = await this.sql`
      SELECT o.slug, o.name
      FROM "member" m
      JOIN "organization" o ON o.id = m."organizationId"
      WHERE m."userId" = ${authInfo.userId}
      ORDER BY o.name ASC
    `;

    const user = result[0] as { id: string; email: string; name: string | null };
    return {
      sub: user.id,
      email: user.email,
      name: user.name,
      organization_slug: organizationSlug,
      organizations: orgs.map((o) => ({ slug: o.slug as string, name: o.name as string })),
    };
  }

  // ============================================
  // Token Revocation
  // ============================================

  /**
   * Revoke a token
   */
  async revokeToken(token: string, clientId: string): Promise<boolean> {
    const tokenHash = hashToken(token);

    const result = await this.sql`
      UPDATE oauth_tokens
      SET revoked_at = NOW()
      WHERE token_hash = ${tokenHash}
        AND client_id = ${clientId}
        AND revoked_at IS NULL
      RETURNING id
    `;

    return result.length > 0;
  }

  /**
   * Revoke all tokens for a user
   */
  async revokeAllUserTokens(userId: string): Promise<number> {
    const result = await this.sql`
      UPDATE oauth_tokens
      SET revoked_at = NOW()
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
      RETURNING id
    `;

    return result.length;
  }

  // ============================================
  // Client Validation
  // ============================================

  /**
   * Get and validate a client for authorization
   */
  async getClientForAuthorization(
    clientId: string,
    redirectUri: string
  ): Promise<OAuthClient | OAuthError> {
    const client = await this.clientsStore.getClient(clientId);

    if (!client) {
      return createOAuthError('invalid_client', 'Unknown client');
    }

    // Validate redirect_uri
    if (!client.redirect_uris.includes(redirectUri)) {
      return createOAuthError('invalid_request', 'Redirect URI not registered for this client');
    }

    // Validate grant type
    if (!client.grant_types?.includes('authorization_code')) {
      return createOAuthError(
        'unauthorized_client',
        'Client not authorized for authorization_code grant'
      );
    }

    return client;
  }

  // ============================================
  // Device Authorization Grant (RFC 8628)
  // ============================================

  /**
   * Create a device authorization request
   *
   * Returns device_code and user_code for the device flow.
   */
  async createDeviceAuthorization(
    clientId: string,
    scope: string | null,
    resource: string | null
  ): Promise<DeviceAuthorizationResponse | OAuthError> {
    const client = await this.clientsStore.getClient(clientId);
    if (!client) {
      return createOAuthError('invalid_client', 'Unknown client_id');
    }

    if (!client.grant_types?.includes('urn:ietf:params:oauth:grant-type:device_code')) {
      return createOAuthError('unauthorized_client', 'Client does not support device_code grant');
    }

    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    const expiresAt = calculateExpiry(DEVICE_CODE_LIFETIME_SECONDS);

    await this.sql`
      INSERT INTO oauth_device_codes (
        device_code, user_code, client_id,
        scope, resource, status, poll_interval, expires_at
      ) VALUES (
        ${deviceCode},
        ${userCode},
        ${clientId},
        ${scope},
        ${resource},
        'pending',
        ${DEVICE_CODE_POLL_INTERVAL_SECONDS},
        ${expiresAt}
      )
    `;

    const verificationUri = `${this.baseUrl}/oauth/device`;

    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${userCode}`,
      expires_in: DEVICE_CODE_LIFETIME_SECONDS,
      interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
    };
  }

  /**
   * Approve a device code (called after user authenticates and consents).
   *
   * `scopeOverride` lets the consent layer narrow the granted scope based on
   * the user's role (e.g. drop `mcp:admin` for non-admin members) before the
   * device code is exchanged for tokens.
   */
  async approveDeviceCode(
    userCode: string,
    userId: string,
    organizationId: string | null,
    scopeOverride?: string | null
  ): Promise<boolean> {
    if (scopeOverride !== undefined) {
      const result = await this.sql`
        UPDATE oauth_device_codes
        SET status = 'approved',
            user_id = ${userId},
            organization_id = ${organizationId},
            scope = ${scopeOverride}
        WHERE user_code = ${userCode}
          AND status = 'pending'
          AND expires_at > NOW()
        RETURNING device_code
      `;
      return result.length > 0;
    }
    const result = await this.sql`
      UPDATE oauth_device_codes
      SET status = 'approved',
          user_id = ${userId},
          organization_id = ${organizationId}
      WHERE user_code = ${userCode}
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING device_code
    `;
    return result.length > 0;
  }

  /**
   * Deny a device code
   */
  async denyDeviceCode(userCode: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE oauth_device_codes
      SET status = 'denied'
      WHERE user_code = ${userCode}
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING device_code
    `;
    return result.length > 0;
  }

  /**
   * Look up a pending device code by user_code for the consent page
   */
  async getDeviceCodeByUserCode(userCode: string): Promise<StoredDeviceCode | null> {
    const result = await this.sql`
      SELECT * FROM oauth_device_codes
      WHERE user_code = ${userCode}
        AND status = 'pending'
        AND expires_at > NOW()
    `;
    if (result.length === 0) return null;
    return result[0] as StoredDeviceCode;
  }

  /**
   * Exchange device code for tokens (polling endpoint)
   *
   * Returns tokens if approved, or appropriate error for pending/denied/expired.
   */
  async exchangeDeviceCode(params: TokenRequestParams): Promise<OAuthTokenResponse | OAuthError> {
    if (!params.device_code) {
      return createOAuthError('invalid_request', 'Missing device_code');
    }

    const clientValidation = await this.validateClientTokenAuthentication(
      params.client_id,
      params.client_secret
    );
    if ('error' in clientValidation) {
      return clientValidation;
    }

    // Atomically claim approved device codes to prevent TOCTOU race conditions.
    // DELETE...RETURNING ensures only one concurrent request can consume the code.
    const approved = await this.sql`
      DELETE FROM oauth_device_codes
      WHERE device_code = ${params.device_code}
        AND client_id = ${params.client_id}
        AND status = 'approved'
        AND expires_at > NOW()
      RETURNING *
    `;

    if (approved.length > 0) {
      const deviceCode = approved[0] as StoredDeviceCode;
      if (!deviceCode.user_id) {
        return createOAuthError('server_error', 'Approved device code missing user_id');
      }
      return this.issueTokens(
        deviceCode.client_id,
        deviceCode.user_id,
        deviceCode.organization_id,
        deviceCode.scope,
        deviceCode.resource
      );
    }

    // Atomic claim returned nothing — check why (pending, denied, expired, or unknown)
    const result = await this.sql`
      SELECT status, client_id, expires_at FROM oauth_device_codes
      WHERE device_code = ${params.device_code}
    `;

    if (result.length === 0) {
      return createOAuthError('invalid_grant', 'Unknown device_code');
    }

    const deviceCode = result[0] as Pick<StoredDeviceCode, 'status' | 'client_id' | 'expires_at'>;

    if (deviceCode.client_id !== params.client_id) {
      return createOAuthError('invalid_grant', 'Client ID mismatch');
    }

    if (new Date(deviceCode.expires_at) <= new Date()) {
      return createOAuthError('expired_token', 'Device code has expired');
    }

    switch (deviceCode.status) {
      case 'pending':
        return createOAuthError('authorization_pending', 'User has not yet authorized');
      case 'denied':
        return createOAuthError('access_denied', 'User denied the authorization request');
      default:
        return createOAuthError('server_error', 'Unexpected device code status');
    }
  }

  // ============================================
  // Metadata
  // ============================================

  /**
   * Get Authorization Server Metadata (RFC 8414)
   */
  getAuthorizationServerMetadata() {
    return {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/oauth/authorize`,
      token_endpoint: `${this.baseUrl}/oauth/token`,
      registration_endpoint: `${this.baseUrl}/oauth/register`,
      revocation_endpoint: `${this.baseUrl}/oauth/revoke`,
      scopes_supported: [...AVAILABLE_SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      device_authorization_endpoint: `${this.baseUrl}/oauth/device_authorization`,
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256'],
      userinfo_endpoint: `${this.baseUrl}/oauth/userinfo`,
      service_documentation: `${this.baseUrl}/docs`,
    };
  }

  /**
   * Get Protected Resource Metadata (RFC 9728)
   */
  getProtectedResourceMetadata() {
    return {
      resource: `${this.baseUrl}/mcp`,
      authorization_servers: [this.baseUrl],
      scopes_supported: [...AVAILABLE_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Owletto',
      resource_documentation: `${this.baseUrl}/docs`,
    };
  }
}
