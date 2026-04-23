import { CredentialService } from '../auth/credentials';
import { getBuiltinProviderConfig } from '../connect/oauth-providers';
import { type DbClient, getDb } from '../db/client';
import { getAuthProfileById, normalizeAuthValues } from './auth-profiles';
import { getOAuthAuthMethods, normalizeConnectorAuthSchema } from './connector-auth';
import { errorMessage } from './errors';
import { parseJsonObject } from './json';
import logger from './logger';

interface ExecutionOAuthCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
}

interface ResolvedExecutionAuth {
  credentials: ExecutionOAuthCredentials | null;
  connectionCredentials: Record<string, string>;
  sessionState: Record<string, unknown> | null;
}

interface ResolveExecutionAuthParams {
  organizationId: string;
  connectionId: number;
  authProfileId?: number | null;
  appAuthProfileId?: number | null;
  credentialDb: DbClient;
  logContext?: Record<string, unknown>;
  logMessage?: string;
}

export async function resolveExecutionAuth(
  params: ResolveExecutionAuthParams
): Promise<ResolvedExecutionAuth> {
  const authProfile = await getAuthProfileById(params.organizationId, params.authProfileId ?? null);
  const appAuthProfile = await getAuthProfileById(
    params.organizationId,
    params.appAuthProfileId ?? null
  );

  let credentials: ExecutionOAuthCredentials | null = null;

  if (authProfile?.profile_kind === 'oauth_account' && authProfile.account_id) {
    try {
      const credentialService = new CredentialService(params.credentialDb);
      const oauthConfig =
        appAuthProfile?.profile_kind === 'oauth_app'
          ? await resolveExecutionOAuthConfig(
              params.organizationId,
              params.connectionId,
              normalizeAuthValues(appAuthProfile.auth_data ?? {})
            )
          : undefined;
      const tokens = await credentialService.getConnectionTokens(
        params.connectionId,
        authProfile.account_id,
        oauthConfig
      );
      if (tokens?.provider && tokens.accessToken) {
        credentials = {
          provider: tokens.provider,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
          scope: tokens.scope,
        };
      }
    } catch (error) {
      logger.warn(
        {
          ...params.logContext,
          connection_id: params.connectionId,
          error: errorMessage(error),
        },
        params.logMessage ?? 'Failed to resolve execution credentials'
      );
    }
  }

  const connectionCredentials = {
    ...normalizeAuthValues(appAuthProfile?.auth_data ?? {}),
    ...normalizeAuthValues(
      authProfile?.profile_kind === 'env' ? (authProfile.auth_data ?? {}) : {}
    ),
  };
  const sessionState =
    authProfile?.profile_kind === 'browser_session' || authProfile?.profile_kind === 'interactive'
      ? ((authProfile.auth_data as Record<string, unknown>) ?? null)
      : null;

  return {
    credentials,
    connectionCredentials,
    sessionState,
  };
}

async function resolveExecutionOAuthConfig(
  organizationId: string,
  connectionId: number,
  appAuthValues: Record<string, string>
): Promise<
  | {
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
    }
  | undefined
> {
  const sql = getDb();
  const rows = await sql`
    SELECT c.connector_key, cd.auth_schema
    FROM connections c
    JOIN connector_definitions cd
      ON cd.key = c.connector_key
     AND cd.organization_id = c.organization_id
     AND cd.status = 'active'
    WHERE c.id = ${connectionId}
      AND c.organization_id = ${organizationId}
    LIMIT 1
  `;

  if (rows.length === 0) return undefined;

  const row = rows[0] as { connector_key: string; auth_schema: unknown };
  const authSchema = normalizeConnectorAuthSchema(row.auth_schema);
  const oauthMethod = getOAuthAuthMethods(authSchema)[0];
  if (!oauthMethod) return undefined;

  const builtin = getBuiltinProviderConfig(oauthMethod.provider);
  const tokenUrl = oauthMethod.tokenUrl ?? builtin?.tokenUrl;
  if (!tokenUrl) return undefined;

  const providerUpper = oauthMethod.provider.toUpperCase();
  const clientIdKey = oauthMethod.clientIdKey || `${providerUpper}_CLIENT_ID`;
  const clientSecretKey = oauthMethod.clientSecretKey || `${providerUpper}_CLIENT_SECRET`;
  const clientId = appAuthValues[clientIdKey];
  if (!clientId) return undefined;

  const clientSecret = appAuthValues[clientSecretKey];
  const authMethod = oauthMethod.tokenEndpointAuthMethod ?? builtin?.tokenEndpointAuthMethod;
  return {
    tokenUrl,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(authMethod ? { authMethod } : {}),
  };
}

export function mergeExecutionConfig(...configs: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    Object.assign(merged, parseJsonObject(config));
  }
  return merged;
}
