/**
 * OAuth Clients Store
 *
 * Manages OAuth client registration and retrieval.
 * Implements RFC 7591 Dynamic Client Registration.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DbClient } from '../../db/client';
import { pgTextArray } from '../../db/client';
import type { OAuthClient, OAuthClientMetadata, StoredOAuthClient } from './types';
import { generateClientId, generateClientSecret } from './utils';

/**
 * Hash a client secret using scrypt (similar security to bcrypt)
 * Format: salt:hash (both hex encoded)
 */
function hashClientSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a client secret against a stored hash
 */
function verifyClientSecret(secret: string, storedHash: string): boolean {
  try {
    const [saltHex, hashHex] = storedHash.split(':');
    if (!saltHex || !hashHex) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expectedHash = Buffer.from(hashHex, 'hex');
    const actualHash = scryptSync(secret, salt, 64);

    return timingSafeEqual(expectedHash, actualHash);
  } catch {
    return false;
  }
}

/**
 * OAuth Clients Store
 *
 * Handles dynamic client registration and client lookup.
 */
export class OAuthClientsStore {
  constructor(private sql: DbClient) {}

  async touchClientActivity(params: {
    clientId: string;
    organizationId?: string | null;
    userId?: string | null;
    agentId?: string | null;
    userAgent?: string | null;
    clientInfo?: Record<string, unknown> | null;
    capabilities?: Record<string, unknown> | null;
  }): Promise<void> {
    const patch: Record<string, unknown> = {
      last_seen_at: Date.now(),
    };

    if (params.agentId) patch.last_agent_id = params.agentId;
    if (params.userAgent) patch.last_user_agent = params.userAgent;
    if (params.clientInfo) patch.last_client_info = params.clientInfo;
    if (params.capabilities) patch.last_capabilities = params.capabilities;

    await this.sql`
      UPDATE oauth_clients
      SET
        organization_id = COALESCE(organization_id, ${params.organizationId ?? null}),
        user_id = COALESCE(user_id, ${params.userId ?? null}),
        metadata = COALESCE(metadata, '{}'::jsonb) || ${this.sql.json(patch)}::jsonb,
        updated_at = NOW()
      WHERE id = ${params.clientId}
    `;
  }

  /**
   * Get a client by ID
   */
  async getClient(clientId: string): Promise<OAuthClient | null> {
    const result = await this.sql`
      SELECT * FROM oauth_clients WHERE id = ${clientId}
    `;

    if (result.length === 0) return null;

    const client = result[0] as StoredOAuthClient;
    return this.toOAuthClient(client);
  }

  /**
   * Register a new client (RFC 7591)
   *
   * @param metadata - Client metadata from registration request
   * @param userId - Optional user ID if client is user-owned
   * @param organizationId - Optional organization ID for scoping
   * @returns Full client info including credentials (shown once)
   */
  async registerClient(
    metadata: OAuthClientMetadata,
    userId?: string,
    organizationId?: string,
    extraMetadata?: Record<string, unknown>
  ): Promise<OAuthClient> {
    const clientId = generateClientId();
    const clientSecret = generateClientSecret();

    // Hash the client secret for storage
    const clientSecretHash = hashClientSecret(clientSecret);

    // Client secret expires in 1 year
    const clientSecretExpiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000);

    await this.sql`
      INSERT INTO oauth_clients (
        id,
        client_secret,
        client_secret_expires_at,
        redirect_uris,
        token_endpoint_auth_method,
        grant_types,
        response_types,
        client_name,
        client_uri,
        logo_uri,
        scope,
        contacts,
        tos_uri,
        policy_uri,
        software_id,
        software_version,
        user_id,
        organization_id,
        metadata
      ) VALUES (
        ${clientId},
        ${clientSecretHash},
        ${clientSecretExpiresAt},
        ${pgTextArray(metadata.redirect_uris)}::text[],
        ${metadata.token_endpoint_auth_method || 'none'},
        ${pgTextArray(metadata.grant_types || ['authorization_code', 'refresh_token'])}::text[],
        ${pgTextArray(metadata.response_types || ['code'])}::text[],
        ${metadata.client_name || null},
        ${metadata.client_uri || null},
        ${metadata.logo_uri || null},
        ${metadata.scope || null},
        ${metadata.contacts ? pgTextArray(metadata.contacts) : null}::text[],
        ${metadata.tos_uri || null},
        ${metadata.policy_uri || null},
        ${metadata.software_id || null},
        ${metadata.software_version || null},
        ${userId || null},
        ${organizationId || null},
        ${this.sql.json(extraMetadata || {})}
      )
    `;

    return {
      ...metadata,
      client_id: clientId,
      client_secret: clientSecret, // Return plaintext, shown only during registration
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: Math.floor(clientSecretExpiresAt.getTime() / 1000),
    };
  }

  /**
   * Verify client credentials
   *
   * @param clientId - Client ID
   * @param clientSecret - Client secret to verify
   * @returns True if credentials are valid
   */
  async verifyClientCredentials(clientId: string, clientSecret: string): Promise<boolean> {
    const result = await this.sql`
      SELECT client_secret, client_secret_expires_at
      FROM oauth_clients
      WHERE id = ${clientId}
    `;

    if (result.length === 0) return false;

    const client = result[0] as Pick<
      StoredOAuthClient,
      'client_secret' | 'client_secret_expires_at'
    >;

    // Check if secret has expired
    if (client.client_secret_expires_at && new Date(client.client_secret_expires_at) < new Date()) {
      return false;
    }

    // Public clients (no secret)
    if (!client.client_secret) {
      return clientSecret === undefined || clientSecret === '';
    }

    // Verify the secret
    return verifyClientSecret(clientSecret, client.client_secret);
  }

  /**
   * Delete a client
   */
  async deleteClient(clientId: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM oauth_clients WHERE id = ${clientId}
      RETURNING id
    `;
    return result.length > 0;
  }

  /**
   * Revoke a client's tokens and MCP sessions only within one organization.
   * Keeps the client registration intact so other organizations are unaffected.
   */
  async revokeClientForOrganization(clientId: string, organizationId: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const revokedTokens = await tx`
        UPDATE oauth_tokens
        SET revoked_at = NOW()
        WHERE client_id = ${clientId}
          AND organization_id = ${organizationId}
          AND revoked_at IS NULL
        RETURNING id
      `;

      const deletedSessions = await tx`
        DELETE FROM mcp_sessions
        WHERE client_id = ${clientId}
          AND organization_id = ${organizationId}
        RETURNING session_id
      `;

      return revokedTokens.length > 0 || deletedSessions.length > 0;
    });
  }

  /**
   * List clients for a user
   */
  async listClientsByUser(userId: string): Promise<OAuthClient[]> {
    const result = await this.sql`
      SELECT * FROM oauth_clients
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;

    return result.map((client) => this.toOAuthClient(client as StoredOAuthClient));
  }

  /**
   * List clients for an organization with user info and active token counts.
   * Discovers clients via oauth_tokens since dynamic client registration
   * (RFC 7591) happens before user auth, so clients may not have organization_id set.
   */
  async listClientsByOrganization(organizationId: string): Promise<
    (OAuthClient & {
      metadata: Record<string, unknown>;
      user_name?: string;
      user_email?: string;
      active_token_count: number;
    })[]
  > {
    const result = await this.sql`
      SELECT
        oc.*,
        tok_agg.user_name,
        tok_agg.user_email,
        COALESCE(tok_agg.active_token_count, 0)::int AS active_token_count
      FROM oauth_clients oc
      INNER JOIN LATERAL (
        SELECT
          MAX(u.name) AS user_name,
          MAX(u.email) AS user_email,
          COUNT(*) FILTER (
            WHERE ot.revoked_at IS NULL AND ot.expires_at > NOW()
          )::int AS active_token_count
        FROM oauth_tokens ot
        LEFT JOIN "user" u ON u.id = ot.user_id
        WHERE ot.client_id = oc.id
          AND ot.organization_id = ${organizationId}
      ) tok_agg ON true
      WHERE oc.organization_id = ${organizationId}
         OR EXISTS (
           SELECT 1 FROM oauth_tokens ot2
           WHERE ot2.client_id = oc.id
             AND ot2.organization_id = ${organizationId}
         )
      ORDER BY oc.created_at DESC
    `;

    return result.map((row) => {
      const client = this.toOAuthClient(row as unknown as StoredOAuthClient);
      return {
        ...client,
        user_name: (row as Record<string, unknown>).user_name as string | undefined,
        user_email: (row as Record<string, unknown>).user_email as string | undefined,
        active_token_count: (row as Record<string, unknown>).active_token_count as number,
      };
    });
  }

  /**
   * Convert stored client to OAuthClient (without secret)
   */
  private toOAuthClient(
    stored: StoredOAuthClient
  ): OAuthClient & { metadata: Record<string, unknown> } {
    return {
      client_id: stored.id,
      // Never return the secret after registration
      client_id_issued_at: Math.floor(new Date(stored.client_id_issued_at).getTime() / 1000),
      client_secret_expires_at: stored.client_secret_expires_at
        ? Math.floor(new Date(stored.client_secret_expires_at).getTime() / 1000)
        : undefined,
      redirect_uris: stored.redirect_uris,
      token_endpoint_auth_method:
        (stored.token_endpoint_auth_method as
          | 'none'
          | 'client_secret_post'
          | 'client_secret_basic') || 'none',
      grant_types: stored.grant_types,
      response_types: stored.response_types,
      client_name: stored.client_name || undefined,
      client_uri: stored.client_uri || undefined,
      logo_uri: stored.logo_uri || undefined,
      scope: stored.scope || undefined,
      contacts: stored.contacts || undefined,
      tos_uri: stored.tos_uri || undefined,
      policy_uri: stored.policy_uri || undefined,
      software_id: stored.software_id || undefined,
      software_version: stored.software_version || undefined,
      metadata: stored.metadata || {},
    };
  }
}
