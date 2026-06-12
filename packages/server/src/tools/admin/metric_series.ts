/**
 * Tool: metric_series
 *
 * Generic read-only SQL endpoint for dashboard sparklines + stat chips.
 * The caller passes a single SELECT (or WITH … SELECT) returning N columns
 * of time-bucketed values. The query goes through the same
 * `validateAndScopeQuery` guard as `query_sql`, plus a few endpoint-local
 * defense layers:
 *
 *   - prefix check: only `SELECT` or `WITH` are accepted (no DML/DDL prefix)
 *   - validateAndScopeQuery: parser-validated, table allowlist, sensitive
 *     column blocklist, user `$N` rejection, auto-scoped via CTEs that
 *     inject `WHERE organization_id = $1` per referenced table
 *   - server-injected `$1`: caller can't choose which org to query
 *   - statement timeout: 5s, enforced via SET LOCAL inside a transaction
 *   - hard row cap: queries returning more than MAX_ROWS rows are rejected
 *   - `internal: true`: hidden from external MCP clients (REST/session only)
 *
 * Returns `{ columns: string[], rows: unknown[][] }`.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import { isReadQuery, validateAndScopeQuery } from '../../utils/execute-data-sources';
import { ADMIN_ONLY_QUERYABLE_TABLES, SAFE_COLUMN_DEFS } from '../../utils/table-schema';
import { ToolUserError } from '../../utils/errors';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { isAdminOrOwnerRole } from '../access-control';

export const MetricSeriesSchema = Type.Object({
  sql: Type.String({
    description:
      'A single SELECT (or WITH … SELECT) returning a bucket column plus one or more numeric stat columns. Table references are auto-scoped to the caller\'s organization; `$1` is the organization id (injected — do not pass it).',
  }),
});

type MetricSeriesArgs = Static<typeof MetricSeriesSchema>;

// Statement timeout in ms. Dashboards refresh frequently — keep tight.
const STATEMENT_TIMEOUT_MS = 5000;

// Hard cap on returned rows. Sparklines need ≤ ~365; anything orders of
// magnitude larger is misuse or a runaway query, so refuse rather than ship
// megabytes back to the client.
const MAX_ROWS = 2000;


export interface MetricSeriesResult {
  columns: string[];
  rows: unknown[][];
}

export const metricSeries = withValidatedArgs('metric_series', MetricSeriesSchema, metricSeriesImpl);

async function metricSeriesImpl(
  args: MetricSeriesArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<MetricSeriesResult> {
  const orgId = ctx.organizationId;
  if (!orgId) {
    throw new Error('metric_series: caller must be scoped to an organization');
  }

  if (!isReadQuery(args.sql)) {
    throw new ToolUserError('metric_series: only SELECT or WITH … SELECT queries are accepted');
  }

  // Members may chart their org's operational data; the auth/identity tables
  // (oauth_tokens, oauth_clients, user) stay admin-only.
  const isAdmin = isAdminOrOwnerRole(ctx.memberRole);
  const { sql: scopedSql, params } = validateAndScopeQuery(args.sql, orgId, {
    // Emit the safe column allowlist (not SELECT *) so a member charting e.g.
    // `connections` can't pull credential columns the allowlist withholds.
    safeColumns: SAFE_COLUMN_DEFS,
    restrictedTables: isAdmin ? undefined : ADMIN_ONLY_QUERYABLE_TABLES,
  });
  const db = getDb();

  // Run inside a transaction so SET LOCAL applies for the user query only.
  // `SET LOCAL` doesn't accept prepared parameters, so the timeout literal is
  // interpolated directly (safe — it's a module-level number).
  let rows: Record<string, unknown>[];
  try {
    rows = (await db.begin(async (tx) => {
      // READ ONLY first: a data-modifying CTE (`WITH x AS (DELETE … RETURNING …)
      // SELECT …`) passes the SELECT/WITH guard, so the DB must refuse the write.
      // Mirrors query_sql; without it this read-tier endpoint could mutate.
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      return tx.unsafe(scopedSql, params as unknown[]);
    })) as Record<string, unknown>[];
  } catch (err) {
    logger.warn({ err, orgId }, '[metric_series] query failed');
    throw err;
  }

  if (rows.length > MAX_ROWS) {
    throw new ToolUserError(
      `metric_series: query returned ${rows.length} rows (cap ${MAX_ROWS}). Bucket the result further or narrow the time window.`
    );
  }

  // postgres.js returns Array<Record<column, value>>. Flatten to a tabular
  // result so the frontend doesn't have to know column order.
  if (rows.length === 0) {
    return { columns: [], rows: [] };
  }
  const columns = Object.keys(rows[0]);
  const tabular = rows.map((r) => columns.map((c) => r[c]));
  return { columns, rows: tabular };
}
