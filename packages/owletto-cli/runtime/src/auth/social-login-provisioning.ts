import { fetchUserInfoWithRaw } from '../connect/oauth-providers';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { splitConfigByFeedScope } from '../tools/admin/helpers/feed-helpers';
import {
  createAuthProfile,
  getPrimaryAuthProfileForKind,
  updateAuthProfile,
} from '../utils/auth-profiles';
import { getOAuthAuthMethods, normalizeConnectorAuthSchema } from '../utils/connector-auth';
import logger from '../utils/logger';
import { syncOAuthConnectionsForAuthProfile } from '../utils/oauth-connection-state';
import { mergeOAuthScopeAuthData, normalizeScopeList } from '../utils/oauth-scopes';
import { createProvisionedConnection } from '../utils/provisioned-connection';
import { resolveRequestOrganizationId } from './config';

interface BetterAuthAccountLike {
  id: string;
  userId: string;
  providerId: string;
  accessToken?: string | null;
  scope?: string | null;
}

export async function provisionConnectorFromSocialLogin(params: {
  env: Env;
  request?: Request | null;
  account: BetterAuthAccountLike;
}): Promise<void> {
  const organizationId = await resolveRequestOrganizationId(params.request ?? undefined);
  if (!organizationId) return;

  const provider = params.account.providerId?.trim().toLowerCase();
  if (!provider || !params.account.userId) return;

  const sql = getDb();
  const connectorRows = await sql`
    SELECT key, name, auth_schema, feeds_schema, default_connection_config
    FROM connector_definitions
    WHERE organization_id = ${organizationId}
      AND status = 'active'
    ORDER BY updated_at DESC
  `;

  for (const row of connectorRows as Array<{
    key: string;
    name: string;
    auth_schema: unknown;
    feeds_schema: Record<string, unknown> | null;
    default_connection_config: Record<string, unknown> | null;
  }>) {
    const authSchema = normalizeConnectorAuthSchema(row.auth_schema);
    const oauthMethod = getOAuthAuthMethods(authSchema).find(
      (method) => method.provider.toLowerCase() === provider
    );
    if (!oauthMethod?.loginProvisioning?.autoCreateConnection) continue;

    const accessToken = params.account.accessToken ?? null;
    const { raw: rawUserInfo, normalized: userInfo } = accessToken
      ? await fetchUserInfoWithRaw({
          provider,
          accessToken,
          userinfoUrl: oauthMethod.userinfoUrl,
        })
      : { raw: null, normalized: null };

    const displayLabel = userInfo?.name ?? userInfo?.email ?? params.account.id;
    const requestedScopes = normalizeScopeList(
      params.account.scope ?? oauthMethod.loginScopes ?? oauthMethod.requiredScopes
    );
    const grantedScopes = normalizeScopeList(params.account.scope);

    const existingProfileRows = await sql`
      SELECT id, slug, auth_data, status, account_id, provider
      FROM auth_profiles
      WHERE organization_id = ${organizationId}
        AND connector_key = ${row.key}
        AND profile_kind = 'oauth_account'
        AND account_id = ${params.account.id}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;

    const existingProfile = existingProfileRows[0] as
      | {
          id: number;
          slug: string;
          auth_data: Record<string, unknown>;
          status: 'active' | 'pending_auth' | 'error' | 'revoked';
          account_id: string | null;
          provider: string | null;
        }
      | undefined;

    const authData = mergeOAuthScopeAuthData(existingProfile?.auth_data ?? {}, {
      requestedScopes,
      grantedScopes,
      identity: rawUserInfo,
    });

    const authProfile = existingProfile
      ? await updateAuthProfile({
          organizationId,
          slug: existingProfile.slug,
          authData,
          accountId: params.account.id,
          provider,
          status: 'active',
        })
      : await createAuthProfile({
          organizationId,
          connectorKey: row.key,
          displayName: `${row.name} (${displayLabel})`,
          slug: `${row.key}-${provider}-account-${displayLabel}`,
          profileKind: 'oauth_account',
          authData,
          accountId: params.account.id,
          provider,
          status: 'active',
          createdBy: params.account.userId,
        });

    if (!authProfile) continue;

    const appAuthProfile = await getPrimaryAuthProfileForKind({
      organizationId,
      connectorKey: row.key,
      profileKind: 'oauth_app',
      provider,
    });

    const existingConnectionRows = await sql`
      SELECT id
      FROM connections
      WHERE organization_id = ${organizationId}
        AND auth_profile_id = ${authProfile.id}
        AND deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;

    if (existingConnectionRows.length === 0 && appAuthProfile) {
      const mergedConfig = {
        ...((row.default_connection_config as Record<string, unknown> | null) ?? {}),
        __auto_provisioned_login: true,
      };
      const splitConfig = splitConfigByFeedScope(
        mergedConfig,
        row.feeds_schema as Record<string, any> | null
      );

      const createResult = await createProvisionedConnection({
        organizationId,
        connectorKey: row.key,
        displayName: `${row.name} (${displayLabel})`,
        authProfileSlug: authProfile.slug,
        appAuthProfileSlug: appAuthProfile.slug,
        config: splitConfig.connectionConfig ?? {},
        userId: params.account.userId,
        env: params.env,
        requestUrl: params.request?.url,
      });

      if (createResult.error) {
        logger.warn(
          {
            organizationId,
            connectorKey: row.key,
            provider,
            error: createResult.error,
          },
          'Failed to auto-provision connector connection from social login'
        );
      }
    }

    await syncOAuthConnectionsForAuthProfile(organizationId, authProfile.id);
  }
}
