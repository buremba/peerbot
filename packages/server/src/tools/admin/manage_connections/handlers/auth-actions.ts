/**
 * Auth-related action handlers: reauthenticate, test.
 */

import { getDb } from '../../../../db/client';
import {
  getAuthProfileById,
  getBrowserSessionReadiness,
  normalizeAuthValues,
  summarizeBrowserSessionAuthData,
} from '../../../../utils/auth-profiles';
import { createAuthRun } from '../../../../runs/queue-service';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../../../../utils/run-statuses';
import type { ToolContext } from '../../../registry';
import type { ManageConnectionsResult, ConnectionsArgs } from '../schemas';
import { callerIsAdmin as resolveCallerIsAdmin } from '../../helpers/db-helpers';

// ============================================
// handleReauthenticate
// ============================================

export async function handleReauthenticate(
  args: Extract<ConnectionsArgs, { action: 'reauthenticate' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  if (!ctx.userId) {
    return { error: 'Authentication required to re-authenticate a connection' };
  }

  const rows = await sql`
    SELECT
      c.id,
      c.status AS connection_status,
      c.connector_key,
      c.auth_profile_id,
      c.created_by AS connection_created_by,
      ap.profile_kind,
      ap.status AS auth_profile_status
    FROM connections c
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    WHERE c.id = ${args.connection_id}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
    LIMIT 1
  `;

  if (rows.length === 0) {
    return { error: 'Connection not found' };
  }

  const row = rows[0] as {
    id: number;
    connection_status: string;
    connector_key: string;
    auth_profile_id: number | null;
    connection_created_by: string | null;
    profile_kind: string | null;
    auth_profile_status: string | null;
  };

  // `reauthenticate` flips the connection + its interactive profile to
  // `pending_auth` and kicks off an auth run — that has to be the connection
  // owner or an admin/owner. Without this gate, any org member could disrupt
  // (or hijack the pairing of) another member's interactive connection.
  const callerIsAdmin = await resolveCallerIsAdmin(sql, { organizationId, userId: ctx.userId });
  if (!callerIsAdmin && row.connection_created_by !== ctx.userId) {
    return { error: 'You can only re-authenticate connections you created.' };
  }

  if (!row.auth_profile_id || row.profile_kind !== 'interactive') {
    return { error: 'Connection does not use an interactive auth profile' };
  }

  const activeRuns = await sql`
    SELECT id, created_by_user_id
    FROM runs
    WHERE auth_profile_id = ${row.auth_profile_id}
      AND run_type = 'auth'
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (activeRuns.length > 0) {
    const existing = activeRuns[0] as { id: unknown; created_by_user_id: string | null };
    if (existing.created_by_user_id && existing.created_by_user_id !== ctx.userId) {
      return {
        error: 'An authentication flow is already in progress for this profile by another user.',
      };
    }
    return {
      action: 'reauthenticate',
      connection_id: row.id,
      auth_run_id: Number(existing.id),
    };
  }

  if (row.auth_profile_status !== 'pending_auth') {
    await sql`
      UPDATE auth_profiles
      SET status = 'pending_auth', updated_at = NOW()
      WHERE id = ${row.auth_profile_id}
    `;
  }

  if (row.connection_status !== 'pending_auth') {
    await sql`
      UPDATE connections
      SET status = 'pending_auth', updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }

  const authRunId = await createAuthRun({
    organizationId,
    connectorKey: row.connector_key,
    authProfileId: row.auth_profile_id,
    createdByUserId: ctx.userId,
  });

  return {
    action: 'reauthenticate',
    connection_id: row.id,
    auth_run_id: authRunId,
  };
}

// ============================================
// handleTest
// ============================================

export async function handleTest(
  args: Extract<ConnectionsArgs, { action: 'test' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const rows = await sql`
    SELECT c.connector_key,
           c.auth_profile_id,
           c.app_auth_profile_id,
           c.status,
           cd.auth_schema
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT auth_schema
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE c.id = ${args.connection_id} AND c.organization_id = ${organizationId}
  `;

  if (rows.length === 0) {
    return { error: 'Connection not found' };
  }

  const conn = rows[0] as any;
  const authProfile = await getAuthProfileById(
    organizationId,
    Number(conn.auth_profile_id) || null
  );
  const appAuthProfile = await getAuthProfileById(
    organizationId,
    Number(conn.app_auth_profile_id) || null
  );

  if (authProfile?.profile_kind === 'oauth_account' && authProfile.account_id) {
    const accountRows = await sql`
      SELECT "accessToken" IS NOT NULL AS has_token,
             "accessTokenExpiresAt",
             "refreshToken" IS NOT NULL AS has_refresh
      FROM "account"
      WHERE id = ${authProfile.account_id}
    `;

    if (accountRows.length === 0) {
      return { action: 'test', status: 'error', message: 'Linked OAuth account not found' };
    }

    const account = accountRows[0] as any;
    if (!account.has_token) {
      return {
        action: 'test',
        status: 'error',
        message: 'No access token available. Re-authenticate.',
      };
    }

    const expiresAt = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt) : null;
    const isExpired = expiresAt && expiresAt.getTime() < Date.now();

    return {
      action: 'test',
      status: isExpired && !account.has_refresh ? 'error' : 'ok',
      message: isExpired
        ? account.has_refresh
          ? 'Token expired but refresh token available'
          : 'Token expired and no refresh token'
        : 'Credentials valid',
      has_token: account.has_token,
      has_refresh: account.has_refresh,
      expires_at: expiresAt?.toISOString() ?? null,
    };
  }

  const profileToTest =
    authProfile?.profile_kind === 'env'
      ? authProfile
      : appAuthProfile?.profile_kind === 'oauth_app'
        ? appAuthProfile
        : null;

  if (profileToTest) {
    const creds = normalizeAuthValues(profileToTest.auth_data);
    const label = profileToTest.profile_kind === 'oauth_app' ? 'App auth' : 'Auth';
    const hasKeys = Object.keys(creds).length > 0;
    return {
      action: 'test',
      status: hasKeys ? 'ok' : 'warning',
      message: hasKeys
        ? `${label} profile '${profileToTest.slug}' configured`
        : `${label} profile '${profileToTest.slug}' has no credentials`,
    };
  }

  if (authProfile?.profile_kind === 'browser_session') {
    const summary = summarizeBrowserSessionAuthData(authProfile.auth_data, conn.connector_key);
    if (summary.cdp_url) {
      const readiness = await getBrowserSessionReadiness(authProfile.auth_data, conn.connector_key);
      return {
        action: 'test',
        status: readiness.usable ? 'ok' : 'warning',
        message: readiness.usable
          ? `Browser auth profile '${authProfile.slug}' CDP endpoint reachable`
          : `Browser auth profile '${authProfile.slug}' CDP configured but endpoint not responding at ${summary.cdp_url}`,
        expires_at: summary.expires_at,
      };
    }
    if (summary.cookie_count === 0) {
      return {
        action: 'test',
        status: 'warning',
        message: `Browser auth profile '${authProfile.slug}' has no cookies`,
        expires_at: summary.expires_at,
      };
    }
    if (!summary.auth_cookie_name) {
      return {
        action: 'test',
        status: 'warning',
        message: `Browser auth profile '${authProfile.slug}' has no likely auth cookie`,
        expires_at: summary.expires_at,
      };
    }
    return {
      action: 'test',
      status: summary.is_expired ? 'error' : 'ok',
      message: summary.is_expired
        ? `${summary.auth_cookie_name} expired`
        : `${summary.auth_cookie_name} valid`,
      expires_at: summary.expires_at,
    };
  }

  return { action: 'test', status: 'warning', message: 'No auth profile configured' };
}
