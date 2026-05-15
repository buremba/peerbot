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
import { validateAndScopeQuery } from '../../utils/execute-data-sources';
import { ToolUserError } from '../../utils/errors';
import logger from '../../utils/logger';
import type { ToolContext } from '../registry';

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

// Only SELECT or WITH … SELECT are valid metric queries. Catches DML/DDL
// prefixes (INSERT/UPDATE/DELETE/TRUNCATE/COPY/CREATE/DROP/ALTER/GRANT/
// REVOKE/VACUUM/ANALYZE/EXPLAIN/SET/RESET/LOCK/CALL/DO/…) before they hit
// the heavier AST validator.
const SELECT_OR_WITH = /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(SELECT|WITH)\b/i;

export interface MetricSeriesResult {
  columns: string[];
  rows: unknown[][];
}

export async function metricSeries(
  args: MetricSeriesArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<MetricSeriesResult> {
  const orgId = ctx.organizationId;
  if (!orgId) {
    throw new Error('metric_series: caller must be scoped to an organization');
  }

  if (!SELECT_OR_WITH.test(args.sql)) {
    throw new ToolUserError('metric_series: only SELECT or WITH … SELECT queries are accepted');
  }

  const { sql: scopedSql, params } = validateAndScopeQuery(args.sql, orgId);
  const db = getDb();

  // Run inside a transaction so SET LOCAL applies for the user query only.
  // `SET LOCAL` doesn't accept prepared parameters, so the timeout literal is
  // interpolated directly (safe — it's a module-level number).
  let rows: Record<string, unknown>[];
  try {
    rows = (await db.begin(async (tx) => {
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
