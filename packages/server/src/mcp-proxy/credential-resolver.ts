/**
 * MCP Proxy Credential Resolver
 *
 * Resolves OAuth credentials for upstream MCP server calls.
 * Uses existing Owletto infrastructure: connections, auth_profiles, accounts.
 */

import { CredentialService } from '../auth/credentials';
import { getDb } from '../db/client';
import { getAuthProfileById } from '../utils/auth-profiles';
import type { ConnectorAuthOAuthMethod } from '../utils/connector-auth';
import { getOAuthAuthMethods, normalizeConnectorAuthSchema } from '../utils/connector-auth';
import logger from '../utils/logger';

export interface ResolvedCredentials {
  accessToken: string;
  tokenType: string;
}

/**
 * Resolve OAuth credentials for an upstream MCP proxy call.
 *
 * Resolution path:
 * 1. Find an active connection for the connector in the org
 * 2. Load the connection's auth_profile (oauth_account kind) to get the account_id
 * 3. Load the connection's app_auth_profile (oauth_app kind) to get client credentials
 * 4. Use CredentialService.getConnectionTokens() with generic OAuth config for auto-refresh
 */
export async function resolveCredentials(
  organizationId: string,
  connectorKey: string
): Promise<ResolvedCredentials | null> {
  const sql = getDb();

  // 1. Find an active connection with an auth profile for this connector
  const connections = await sql`
    SELECT
      c.id,
      c.auth_profile_id,
      c.app_auth_profile_id,
      c.connector_key
    FROM connections c
    JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    WHERE c.organization_id = ${organizationId}
      AND c.connector_key = ${connectorKey}
      AND ap.account_id IS NOT NULL
      AND ap.profile_kind = 'oauth_account'
    ORDER BY c.updated_at DESC
    LIMIT 1
  `;

  if (connections.length === 0) {
    logger.debug({ organizationId, connectorKey }, '[McpProxy] No connection with account found');
    return null;
  }

  return resolveCredentialsForConnection(connections[0] as ConnectionRow, organizationId, {
    connectorKey,
  });
}

/**
 * Resolve OAuth credentials for a specific connection by ID.
 * Used for multi-account support when the caller specifies which connection to use.
 */
export async function resolveCredentialsByConnectionId(
  connectionId: number,
  organizationId: string
): Promise<ResolvedCredentials | null> {
  const sql = getDb();

  const connections = await sql`
    SELECT
      c.id,
      c.auth_profile_id,
      c.app_auth_profile_id,
      c.connector_key
    FROM connections c
    JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    WHERE c.id = ${connectionId}
      AND c.organization_id = ${organizationId}
      AND ap.account_id IS NOT NULL
      AND ap.profile_kind = 'oauth_account'
    LIMIT 1
  `;

  if (connections.length === 0) {
    logger.debug({ connectionId, organizationId }, '[McpProxy] No connection found by ID');
    return null;
  }

  return resolveCredentialsForConnection(connections[0] as ConnectionRow, organizationId, {
    connectionId,
  });
}

interface ConnectionRow {
  id: number;
  auth_profile_id: number | null;
  app_auth_profile_id: number | null;
  connector_key: string;
}

/**
 * Shared implementation: build OAuth config and resolve tokens for a connection row.
 */
async function resolveCredentialsForConnection(
  connection: ConnectionRow,
  organizationId: string,
  logContext: Record<string, unknown>
): Promise<ResolvedCredentials | null> {
  const sql = getDb();

  // Build OAuth config from app_auth_profile + connector auth_schema for generic refresh
  let oauthConfig:
    | {
        tokenUrl: string;
        clientId: string;
        clientSecret?: string;
        authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
      }
    | undefined;

  const oauthMethod = await getOAuthMethodForConnector(connection.connector_key, organizationId);

  const authProfile = await getAuthProfileById(organizationId, connection.auth_profile_id);
  if (!authProfile?.account_id) {
    logger.debug({ organizationId, ...logContext }, '[McpProxy] OAuth account profile missing');
    return null;
  }

  if (oauthMethod && connection.app_auth_profile_id) {
    const appProfile = await getAuthProfileById(organizationId, connection.app_auth_profile_id);
    if (appProfile?.auth_data) {
      const clientIdKey =
        oauthMethod.clientIdKey || `${oauthMethod.provider.toUpperCase()}_CLIENT_ID`;
      const clientSecretKey =
        oauthMethod.clientSecretKey || `${oauthMethod.provider.toUpperCase()}_CLIENT_SECRET`;

      const clientId = appProfile.auth_data[clientIdKey] as string | undefined;
      const clientSecret = appProfile.auth_data[clientSecretKey] as string | undefined;
      const tokenUrl = oauthMethod.tokenUrl;

      if (tokenUrl && clientId) {
        oauthConfig = {
          tokenUrl,
          clientId,
          clientSecret,
          authMethod: oauthMethod.tokenEndpointAuthMethod,
        };
      }
    }
  }

  // Get tokens with auto-refresh
  const credentialService = new CredentialService(sql);
  const tokens = await credentialService.getConnectionTokens(
    connection.id,
    authProfile.account_id,
    oauthConfig
  );

  if (!tokens?.accessToken) {
    logger.debug({ organizationId, ...logContext }, '[McpProxy] No access token available');
    return null;
  }

  return {
    accessToken: tokens.accessToken,
    tokenType: 'Bearer',
  };
}

/**
 * Look up the OAuth method from a connector's auth_schema.
 */
async function getOAuthMethodForConnector(
  connectorKey: string,
  organizationId: string
): Promise<ConnectorAuthOAuthMethod | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT auth_schema
    FROM connector_definitions
    WHERE key = ${connectorKey}
      AND status = 'active'
      AND organization_id = ${organizationId}
    LIMIT 1
  `;

  if (rows.length === 0 || !rows[0].auth_schema) return null;

  const authSchema = normalizeConnectorAuthSchema(rows[0].auth_schema);
  const oauthMethods = getOAuthAuthMethods(authSchema);
  return oauthMethods.length > 0 ? oauthMethods[0] : null;
}
