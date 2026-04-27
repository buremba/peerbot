/**
 * Tool: query_sql
 *
 * Server-side paginated, sortable, searchable table queries.
 * SQL is auto-scoped to the caller's organization via CTE wrapping.
 * Table references are validated against an allowlist.
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import { validateAndScopeQuery } from '../../utils/execute-data-sources';
import logger from '../../utils/logger';
import { raceAbort } from '../../utils/race-abort';
import { SAFE_COLUMN_DEFS } from '../../utils/table-schema';
import { getCachedMembershipRole, getCachedOrgBySlug } from '../../workspace/multi-tenant';
import type { ToolContext } from '../registry';

export const QuerySqlSchema = Type.Object({
  sql: Type.String({
    description:
      'Base SELECT query. Table references are auto-scoped to your organization. Do NOT include ORDER BY, LIMIT, or OFFSET — they are added automatically.',
  }),
  org_slug: Type.Optional(
    Type.String({
      description:
        'Optional. Only honored on the unscoped `/mcp` endpoint with OAuth auth. Rejected for PAT auth, browser-session auth, and scoped `/mcp/{slug}` connections — re-connect to the target workspace instead.',
    })
  ),
  sort_by: Type.String({
    description: 'Column name to sort by.',
  }),
  sort_order: Type.Optional(
    Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
      description: 'Sort direction. Default: asc.',
    })
  ),
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

interface QuerySqlResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total_count: number;
  has_more: boolean;
  execution_time_ms: number;
  error?: string;
}

const TRAILING_CLAUSES = /\b(ORDER\s+BY|LIMIT|OFFSET)\b/i;
const COLUMN_NAME_RE = /^[a-zA-Z_]\w*$/;

const PG_OID_TYPE_MAP: Record<number, string> = {
  16: 'boolean',
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

export async function querySql(
  args: QuerySqlArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<QuerySqlResult> {
  const startTime = Date.now();

  const baseSql = args.sql.trim();
  if (!baseSql) return errorResult('SQL query is required.', startTime);

  if (TRAILING_CLAUSES.test(baseSql)) {
    return errorResult(
      'Do not include ORDER BY, LIMIT, or OFFSET in your SQL — they are added automatically.',
      startTime
    );
  }

  if (!COLUMN_NAME_RE.test(args.sort_by)) {
    return errorResult(`Invalid sort_by column name: ${args.sort_by}`, startTime);
  }

  // Resolve the target organization. By default, the caller's bound org. When
  // `org_slug` is supplied: only OAuth on the unscoped /mcp endpoint may
  // cross-org. The single source of truth is `ctx.allowCrossOrg`, which is
  // computed from `tokenType === 'oauth' && !scopedToOrg`.
  let targetOrgId = ctx.organizationId;
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
    // `query_sql` is admin-tier (it can read audit/event tables); the cross-
    // org hop must re-validate that constraint against the *target* org's
    // role, not just the caller's role in the bound org.
    if (role !== 'owner' && role !== 'admin') {
      return errorResult(
        `Cross-org query_sql requires owner or admin access in '${args.org_slug}'.`,
        startTime
      );
    }
    targetOrgId = targetOrg.id;
  }

  // Validate, parse, and org-scope the query
  let scopedSql: string;
  let params: unknown[];
  try {
    const scoped = validateAndScopeQuery(baseSql, targetOrgId, {
      safeColumns: SAFE_COLUMN_DEFS,
    });
    scopedSql = scoped.sql;
    params = scoped.params;
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err), startTime);
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

  // TypeBox schemas don't auto-validate at runtime in this codebase, so coerce
  // numeric args to integers here before they reach raw SQL. A non-number
  // limit/offset would otherwise interpolate as a string and bypass the
  // intended bounds.
  const sortOrder = args.sort_order === 'desc' ? 'DESC' : 'ASC';
  const rawLimit = Number(args.limit ?? 50);
  const rawOffset = Number(args.offset ?? 0);
  if (!Number.isFinite(rawLimit) || !Number.isFinite(rawOffset)) {
    return errorResult('limit and offset must be numbers.', startTime);
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(rawLimit)));
  const offset = Math.max(0, Math.trunc(rawOffset));

  const countSql = `SELECT count(*)::int AS c FROM (${scopedSql}) AS _t ${searchWhere}`;
  const dataSql = `SELECT * FROM (${scopedSql}) AS _t ${searchWhere} ORDER BY "${args.sort_by}" ${sortOrder} LIMIT ${limit} OFFSET ${offset}`;

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
    const msg = error instanceof Error ? error.message : String(error);
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
