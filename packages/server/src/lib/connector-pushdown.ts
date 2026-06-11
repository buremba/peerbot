/**
 * Pushdown: run a read-only query LIVE against a connection's source by invoking
 * its connector in `query` mode — no copy, no events. Used by query_sql when a
 * `connection` is given, and (later) by virtual-feed reads. The DB socket lives
 * in the connector subprocess (behind the worker egress controls), never in the
 * gateway. Reuses the same inline-run path as operations.execute (feed-sync.ts).
 */

import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { getDb } from '../db/client';
import { isCloudMode } from '../utils/cloud-mode';
import { assertConnectorAllowedInCloud } from '../utils/connector-cloud-gate';
import { resolveConnectorCode } from '../utils/ensure-connector-installed';
import { resolveExecutionAuth } from '../utils/execution-context';

export interface ConnectorQueryParams {
  organizationId: string;
  /** Connection slug (org-scoped). */
  connectionSlug: string;
  /** Read-only SQL to push down (a derived entity's backing_sql, or a feed query). */
  query: string;
  /** Caller identity — enforces the same connection visibility as manage_connections. */
  userId: string | null;
  /** Owner/admin callers see every connection; members only org-visible or their own. */
  isAdmin: boolean;
  feedKey?: string;
  config?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
}

export interface ConnectorQueryResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total?: number;
}

export async function runConnectorQuery(p: ConnectorQueryParams): Promise<ConnectorQueryResult> {
  const sql = getDb();
  // Resolve org-scoped + active, enforcing the same visibility as manage_connections:
  // a member only reaches org-visible connections or ones they created.
  const connRows = await sql`
    SELECT id, connector_key, auth_profile_id, app_auth_profile_id
    FROM connections
    WHERE organization_id = ${p.organizationId}
      AND slug = ${p.connectionSlug}
      AND deleted_at IS NULL
      AND status = 'active'
      AND (${p.isAdmin} OR visibility = 'org' OR created_by = ${p.userId})
    LIMIT 1
  `;
  if (connRows.length === 0) {
    throw new Error(`source connection '${p.connectionSlug}' not found or not accessible`);
  }
  const conn = connRows[0] as {
    id: number;
    connector_key: string;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
  };

  // Execution-time cloud gate: blocking connection CREATION isn't enough — an
  // existing raw-DB connection must not run pushdown under LOBU_CLOUD_MODE either.
  assertConnectorAllowedInCloud(conn.connector_key);

  const compiledRows = await sql`
    SELECT compiled_code FROM connector_versions
    WHERE connector_key = ${conn.connector_key}
    ORDER BY created_at DESC LIMIT 1
  `;
  const rawCode =
    (compiledRows[0] as { compiled_code: string | null } | undefined)?.compiled_code ?? null;
  const compiledCode = await resolveConnectorCode(conn.connector_key, rawCode);

  const { credentials, connectionCredentials, sessionState } = await resolveExecutionAuth({
    organizationId: p.organizationId,
    connectionId: conn.id,
    authProfileId: Number(conn.auth_profile_id) || null,
    appAuthProfileId: Number(conn.app_auth_profile_id) || null,
    credentialDb: getDb(),
    logContext: { connection: p.connectionSlug },
    logMessage: 'Failed to resolve connector query credentials',
  });

  const result = await executeCompiledConnector({
    compiledCode,
    job: {
      mode: 'query',
      feedKey: p.feedKey ?? null,
      query: p.query,
      // ONLY the connection's own credentials reach ctx.config — deliberately NOT
      // the gateway's process.env, so a connection missing DATABASE_URL fails
      // cleanly instead of falling back to Lobu's own DB. The egress policy is the
      // one non-credential we inject: under cloud mode a DB connector must reject
      // internal/metadata hosts (block-private); self-hosted reaches its own
      // private DB (allow-private). env is {} so this is the only channel for it.
      // Injected LAST so neither caller config nor credentials can override this
      // security control.
      config: {
        ...connectionCredentials,
        ...(p.config ?? {}),
        LOBU_DB_EGRESS_POLICY: isCloudMode() ? 'block-private' : 'allow-private',
      },
      env: {},
      sessionState,
      credentials,
      limit: p.limit,
      offset: p.offset,
      sort: p.sort,
    },
  });

  if (result.mode !== 'query') {
    throw new Error(`Expected query result, got mode=${result.mode}`);
  }
  return { rows: result.rows, columns: result.columns ?? [], total: result.total };
}
