/**
 * Tool: query_sql
 *
 * Server-side paginated, sortable, searchable table queries.
 * SQL is auto-scoped to the caller's organization via CTE wrapping.
 * Table references are validated against an allowlist.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import { runConnectorQuery } from '../../lib/connector-pushdown';
import { validateAndScopeQuery } from '../../utils/execute-data-sources';
import logger from '../../utils/logger';
import { raceAbort } from '../../utils/race-abort';
import { ADMIN_ONLY_QUERYABLE_TABLES, SAFE_COLUMN_DEFS } from '../../utils/table-schema';
import { getCachedMembershipRole, getCachedOrgBySlug } from '../../workspace/multi-tenant';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { SortOrderField } from './schemas/common-fields';
import { isAdminOrOwnerRole } from '../access-control';
import { getErrorMessage } from "@lobu/core";

export const QuerySqlSchema = Type.Object({
  sql: Type.String({
    description:
      'Base SELECT query. Table references are auto-scoped to your organization. It is wrapped as a subquery, so ORDER BY / LIMIT / window functions inside it are fine; pagination + sort are added on the outside via sort_by/limit/offset.',
  }),
  connection: Type.Optional(
    Type.String({
      description:
        'Optional connection slug. When set, `sql` runs LIVE (read-only) against that connection’s external database via its connector (pushdown), and the internal org-scoping is skipped. When unset, the query runs over your org’s internal tables.',
    })
  ),
  org_slug: Type.Optional(
    Type.String({
      description:
        'Optional. Only honored on the unscoped `/mcp` endpoint with OAuth auth. Rejected for PAT auth, browser-session auth, and scoped `/mcp/{slug}` connections — re-connect to the target workspace instead.',
    })
  ),
  sort_by: Type.Optional(
    Type.String({
      description: 'Column name to sort by. Omit to return rows unordered (e.g. a view whose columns you don\'t know upfront).',
    })
  ),
  sort_order: SortOrderField('Sort direction. Default: asc.'),
  limit: Type.Optional(
    Type.Number({
      description: 'Rows per page (1–500). Default: 50.',
      minimum: 1,
      maximum: 500,
    })
  ),
  offset: Type.Optional(
    Type.Number({
      description: 'Row offset for pagination. Default: 0.',
      minimum: 0,
    })
  ),
  search_term: Type.Optional(
    Type.String({ description: 'ILIKE search value (wrapped in %...% automatically).' })
  ),
  search_columns: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Columns to search across (required when search_term is set).',
    })
  ),
});

type QuerySqlArgs = Static<typeof QuerySqlSchema>;

const COLUMN_NAME_RE = /^[a-zA-Z_]\w*$/;

const PG_OID_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  19: 'name',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  26: 'oid',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

function oidToTypeName(oid: number): string {
  return PG_OID_TYPE_MAP[oid] ?? 'unknown';
}

interface QuerySqlResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total_count: number;
  has_more: boolean;
  execution_time_ms: number;
  error?: string;
}

/**
 * Coerce + clamp the page bounds. TypeBox schemas aren't runtime-validated in
 * this codebase, so a non-number limit/offset would otherwise interpolate as a
 * string into raw SQL and bypass the intended bounds. Shared by the internal and
 * external (connection pushdown) branches.
 */
function coercePageBounds(
  args: QuerySqlArgs
): { limit: number; offset: number } | { error: string } {
  const rawLimit = Number(args.limit ?? 50);
  const rawOffset = Number(args.offset ?? 0);
  if (!Number.isFinite(rawLimit) || !Number.isFinite(rawOffset)) {
    return { error: 'limit and offset must be numbers.' };
  }
  return {
    limit: Math.max(1, Math.min(500, Math.trunc(rawLimit))),
    offset: Math.max(0, Math.trunc(rawOffset)),
  };
}

function errorResult(message: string, startTime: number): QuerySqlResult {
  return {
    rows: [],
    columns: [],
    total_count: 0,
    has_more: false,
    execution_time_ms: Date.now() - startTime,
    error: message,
  };
}

export const querySql = withValidatedArgs('query_sql', QuerySqlSchema, querySqlImpl);

export async function querySqlImpl(
  args: QuerySqlArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<QuerySqlResult> {
  const startTime = Date.now();

  const baseSql = args.sql.trim();
  if (!baseSql) return errorResult('SQL query is required.', startTime);

  // The base query is wrapped as `SELECT * FROM (<sql>) _t [ORDER BY …] LIMIT …`,
  // so an ORDER BY / LIMIT / window inside the caller's SQL is valid (it sits in
  // the subquery). A derived view's backing_sql commonly has `OVER (ORDER BY …)`.

  // sort_by is optional: omit it for a view whose columns aren't known upfront.
  if (args.sort_by !== undefined && !COLUMN_NAME_RE.test(args.sort_by)) {
    return errorResult(`Invalid sort_by column name: ${args.sort_by}`, startTime);
  }

  // search_columns only filters in concert with search_term — passing it alone
  // is a silent no-op on both the internal and external paths, which reads as
  // "a filter was applied" when none was. Reject it so the caller notices.
  if (args.search_columns?.length && !args.search_term) {
    return errorResult(
      'search_columns has no effect without search_term — set search_term to filter, or drop search_columns.',
      startTime
    );
  }

  // Resolve the target organization. By default, the caller's bound org. When
  // `org_slug` is supplied: only OAuth on the unscoped /mcp endpoint may
  // cross-org. The single source of truth is `ctx.allowCrossOrg`, which is
  // computed from `tokenType === 'oauth' && !scopedToOrg`.
  let targetOrgId = ctx.organizationId;
  // Members may query their own org's operational tables; the auth/identity
  // tables stay admin-only (enforced via restrictedTables below).
  let callerIsAdmin = isAdminOrOwnerRole(ctx.memberRole);
  if (args.org_slug) {
    if (!ctx.allowCrossOrg) {
      if (ctx.scopedToOrg) {
        return errorResult(
          '`org_slug` is not allowed on /mcp/{slug} connections. Reconnect to /mcp to query a different workspace, or omit `org_slug`.',
          startTime
        );
      }
      return errorResult(
        '`org_slug` requires an OAuth session on /mcp. PAT and session auth pin to a single org.',
        startTime
      );
    }
    if (!ctx.userId) {
      return errorResult('`org_slug` requires an authenticated user context.', startTime);
    }
    const targetOrg = await getCachedOrgBySlug(args.org_slug);
    if (!targetOrg) {
      return errorResult(`Organization '${args.org_slug}' not found.`, startTime);
    }
    const role = await getCachedMembershipRole(targetOrg.id, ctx.userId);
    if (role === null) {
      return errorResult(
        `Not a member of organization '${args.org_slug}'.`,
        startTime
      );
    }
    targetOrgId = targetOrg.id;
    // Reaching into ANOTHER workspace stays owner/admin-only. Passing your OWN
    // org slug is just an explicit form of the default and stays read-tier —
    // don't reject a member or silently escalate them to admin. Either way the
    // role is re-validated against the *target* org, not the bound-org role.
    if (targetOrg.id !== ctx.organizationId) {
      if (role !== 'owner' && role !== 'admin') {
        return errorResult(
          `Cross-org query_sql requires owner or admin access in '${args.org_slug}'.`,
          startTime
        );
      }
      callerIsAdmin = true; // cross-org already required owner/admin in the target
    } else {
      callerIsAdmin = isAdminOrOwnerRole(role);
    }
  }

  // External pushdown: when a connection is named, the SQL runs LIVE against that
  // connection's database via its connector (no internal org-scoping — it's the
  // org's own DB, read-only). The connection is resolved org-scoped inside
  // runConnectorQuery; access is bounded by the connection's read-only DB role.
  if (args.connection) {
    if (args.search_term) {
      return errorResult(
        'search_term is not supported with an external connection — use search_memory.',
        startTime
      );
    }
    const bounds = coercePageBounds(args);
    if ('error' in bounds) return errorResult(bounds.error, startTime);
    const { limit, offset } = bounds;
    try {
      const r = await runConnectorQuery({
        organizationId: targetOrgId,
        connectionSlug: args.connection,
        query: baseSql,
        userId: ctx.userId,
        isAdmin: callerIsAdmin,
        limit,
        offset,
        sort: args.sort_by
          ? { column: args.sort_by, order: args.sort_order === 'desc' ? 'desc' : 'asc' }
          : undefined,
      });
      return {
        rows: r.rows,
        columns: r.columns,
        total_count: r.total ?? r.rows.length,
        has_more: r.total !== undefined ? offset + limit < r.total : r.rows.length >= limit,
        execution_time_ms: Date.now() - startTime,
      };
    } catch (err) {
      return errorResult(getErrorMessage(err), startTime);
    }
  }

  // Validate, parse, and org-scope the query
  let scopedSql: string;
  let params: unknown[];
  try {
    const scoped = validateAndScopeQuery(baseSql, targetOrgId, {
      safeColumns: SAFE_COLUMN_DEFS,
      restrictedTables: callerIsAdmin ? undefined : ADMIN_ONLY_QUERYABLE_TABLES,
    });
    scopedSql = scoped.sql;
    params = scoped.params;
  } catch (err) {
    return errorResult(getErrorMessage(err), startTime);
  }

  // Build search WHERE clause
  let searchWhere = '';
  if (args.search_term) {
    if (!args.search_columns?.length) {
      return errorResult('search_columns is required when search_term is set.', startTime);
    }
    for (const col of args.search_columns) {
      if (!COLUMN_NAME_RE.test(col)) {
        return errorResult(`Invalid search column name: ${col}`, startTime);
      }
    }
    const searchParamRef = `$${params.length + 1}`;
    params.push(`%${args.search_term.toLowerCase()}%`);
    const orClauses = args.search_columns.map((col) => `lower("${col}") LIKE ${searchParamRef}`);
    searchWhere = `WHERE (${orClauses.join(' OR ')})`;
  }

  const sortOrder = args.sort_order === 'desc' ? 'DESC' : 'ASC';
  const bounds = coercePageBounds(args);
  if ('error' in bounds) return errorResult(bounds.error, startTime);
  const { limit, offset } = bounds;

  const countSql = `SELECT count(*)::int AS c FROM (${scopedSql}) AS _t ${searchWhere}`;
  const orderBy = args.sort_by ? `ORDER BY "${args.sort_by}" ${sortOrder}` : '';
  const dataSql = `SELECT * FROM (${scopedSql}) AS _t ${searchWhere} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

  try {
    const sql = getDb();
    // Race the DB transaction against the sandbox abort signal so the handler
    // returns promptly when the script times out. The 5s `statement_timeout`
    // is the actual hard cap on the postgres side (postgres.js doesn't expose
    // an AbortSignal hook); raceAbort just unblocks the awaiting caller.
    const txPromise = sql.begin(async (tx: typeof sql) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      const cnt = await tx.unsafe(countSql, params);
      const data = await tx.unsafe(dataSql, params);
      return [cnt, data] as const;
    });
    const [countResult, dataResult] = await raceAbort(txPromise, ctx.abortSignal);

    const totalCount = countResult[0]?.c ?? 0;

    const columns = ((dataResult as any).columns ?? []).map(
      (col: { name: string; type: number }) => ({
        name: col.name,
        type: oidToTypeName(col.type),
      })
    );

    return {
      rows: Array.isArray(dataResult) ? dataResult : [],
      columns,
      total_count: totalCount,
      has_more: offset + limit < totalCount,
      execution_time_ms: Date.now() - startTime,
    };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error({ error }, 'query_sql error');

    if (msg.includes('timeout') || msg.includes('statement timeout')) {
      return errorResult('QUERY_TIMEOUT: Query exceeded 5 second timeout.', startTime);
    }
    if (msg.includes('read-only')) {
      return errorResult('READ_ONLY_VIOLATION: Only read-only queries are allowed.', startTime);
    }
    return errorResult(`SQL_ERROR: ${msg}`, startTime);
  }
}
