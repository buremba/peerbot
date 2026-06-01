/**
 * Pushdown: run a read-only query LIVE against a connection's source by invoking
 * its connector in `query` mode — no copy, no events. Used by query_sql when a
 * `connection` is given, and (later) by virtual-feed reads. The DB socket lives
 * in the connector subprocess (behind the worker egress controls), never in the
 * gateway. Reuses the same inline-run path as operations.execute (feed-sync.ts).
 */

import { executeCompiledConnector } from '@lobu/connector-worker/executor/runtime';
import { getDb } from '../db/client';
import { resolveConnectorCode } from '../utils/ensure-connector-installed';
import { resolveExecutionAuth } from '../utils/execution-context';

export interface ConnectorQueryParams {
  organizationId: string;
  /** Connection slug (org-scoped). */
  connectionSlug: string;
  /** Read-only SQL to push down (a derived entity's backing_sql, or a feed query). */
  query: string;
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
  const connRows = await sql`
    SELECT id, connector_key, auth_profile_id, app_auth_profile_id
    FROM connections
    WHERE organization_id = ${p.organizationId}
      AND slug = ${p.connectionSlug}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (connRows.length === 0) {
    throw new Error(`source connection '${p.connectionSlug}' no longer exists`);
  }
  const conn = connRows[0] as {
    id: number;
    connector_key: string;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
  };

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
      // cleanly instead of falling back to Lobu's own DB.
      config: { ...connectionCredentials, ...(p.config ?? {}) },
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
