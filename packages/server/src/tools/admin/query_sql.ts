/**
 * Tool: query_sql
 *
 * Server-side paginated, sortable, searchable table queries.
 * SQL is auto-scoped to the caller's organization via CTE wrapping.
 * Table references are validated against an allowlist.
 */

import { type Static, Type } from '@sinclair/typebox';
import { type AuthzScope, authzScopeFromToolContext } from '../../authz/scope';
import { compileConnectionRowVisibility } from '../../authz/connection-visibility';
import { getDb } from '../../db/client';
import { readVirtualFeed, runConnectorQuery } from '../../lib/connector-pushdown';
import { validateAndScopeQuery } from '../../utils/execute-data-sources';
import logger from '../../utils/logger';
import { raceAbort } from '../../utils/race-abort';
import { ADMIN_ONLY_QUERYABLE_TABLES, SAFE_COLUMN_DEFS } from '../../utils/table-schema';
import { getCachedMembershipRole, getCachedOrgBySlug } from '../../workspace/multi-tenant';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { SortOrderField } from './schemas/common-fields';
import { isAdminOrOwnerRole } from '../access-control';
import { classifyToolError, getErrorMessage, isRetryable, type ToolErrorCode } from "@lobu/core";
import { ToolUserError } from '../../utils/errors';

export const QuerySqlSchema = Type.Object({
  title: Type.Optional(
    Type.String({
      description:
        'Optional human-friendly heading for this result (e.g. "Recent support tickets"). When set, the UI renders it in the query result summary.',
      maxLength: 200,
    })
  ),
  sql: Type.Optional(
    Type.String({
      description:
        'Base SELECT query. Required unless `feed` is set. Table references are auto-scoped to your organization. `SELECT FROM events` reads persisted/synced content only; virtual feeds are live-only and are not included. It is wrapped as a subquery, so ORDER BY / LIMIT / window functions inside it are fine; pagination + sort are added on the outside via sort_by/limit/offset.',
    })
  ),
  connection: Type.Optional(
    Type.String({
      description:
        'Optional connection slug. When set, `sql` runs LIVE (read-only) against that connection’s external database via its connector (pushdown), and the internal org-scoping is skipped. When unset, the query runs over your org’s internal tables.',
    })
  ),
  feed: Type.Optional(
    Type.String({
      description:
        'Optional virtual-feed reference (numeric feed id, or "connection_slug/feed_key"). When set, the feed’s STORED config.query runs LIVE against its source (no `sql` needed — it is ignored). `search_term` is forwarded to the connector search() pushdown (each connector interprets it — e.g. Gmail query syntax AND-composed with config.query). Mutually exclusive with `connection`.',
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
    Type.String({
      description:
        'Internal SQL: ILIKE search value. Virtual feeds: forwarded to connector search() — interpretation is connector-specific (Gmail: search syntax merged with config.query).',
    })
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

export const QuerySqlResultSchema = Type.Object({
  title: Type.Optional(
    Type.String({
      description: 'The caller-supplied human-friendly heading for this result, echoed back for the UI.',
      maxLength: 200,
    })
  ),
  sql: Type.Optional(
    Type.String({
      description:
        'The original caller-supplied SQL statement. This is never the tenant-scoped SQL rewritten by Lobu and is absent for stored virtual-feed queries.',
    })
  ),
  rows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  columns: Type.Array(
    Type.Object({
      name: Type.String(),
      type: Type.String(),
    })
  ),
  total_count: Type.Integer(),
  has_more: Type.Boolean(),
  execution_time_ms: Type.Number(),
  coverage: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  error_code: Type.Optional(Type.String()),
  retryable: Type.Optional(Type.Boolean()),
});

interface QuerySqlResult {
  title?: string;
  sql?: string;
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total_count: number;
  has_more: boolean;
  execution_time_ms: number;
  coverage?: QuerySqlCoverage;
  error?: string;
  /** Structured error code (lobu#2051 Item 2), set alongside `error`. */
  error_code?: ToolErrorCode;
  /** Whether retrying the identical query may succeed. Advisory for the agent. */
  retryable?: boolean;
}

interface SuggestedVirtualFeed {
  feed_id: number;
  feed: string;
  connection_slug: string;
  feed_key: string;
  display_name: string | null;
  connector_key: string;
  suggested_limit: number;
}

interface QuerySqlCoverage {
  source: 'persisted_events_only';
  warning: string;
  suggested_virtual_feeds: SuggestedVirtualFeed[];
  more_available: boolean;
  suggested_execution: {
    tool: 'query_sdk';
    method: 'client.feeds.readMany';
    latency_note: string;
    example: string;
  };
}

const MAX_SUGGESTED_VIRTUAL_FEEDS = 5;
const VIRTUAL_FEED_SUGGESTED_LIMIT = 25;

// Cost-attribution ledger: a single expensive user/derived query is how an org
// degrades the shared DB for everyone (precedent: the 3.5s subscription view).
// Anything at or above this gets an alertable, structured entry so expensive
// queries can be rolled up per org in Loki and cross-referenced against
// pg_stat_statements for the normalized SQL.
const SLOW_QUERY_COST_MS = 500;

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

/**
 * Resolve a `feed` reference to a numeric virtual-feed id under `scope`. Accepts
 * a bare numeric id or "connection_slug/feed_key". Applies the SAME
 * connection-visibility gate every read seam uses, so a member can only address a
 * feed on an org-visible or self-owned connection. readVirtualFeed re-checks
 * visibility + asserts virtual=true, so this only needs to disambiguate the ref.
 */
async function resolveVirtualFeedId(ref: string, scope: AuthzScope): Promise<number> {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(
      `invalid feed reference '${ref}' — use a numeric feed id or "connection_slug/feed_key"`
    );
  }
  const connectionSlug = trimmed.slice(0, slash);
  const feedKey = trimmed.slice(slash + 1);

  const sql = getDb();
  const vis = compileConnectionRowVisibility(scope, 'c');
  const rows = (await sql.unsafe(
    `SELECT f.id
     FROM feeds f
     JOIN connections c ON c.id = f.connection_id
     WHERE f.organization_id = $1
       AND c.slug = $2
       AND f.feed_key = $3
       AND f.deleted_at IS NULL
       AND c.deleted_at IS NULL
       ${vis}
     LIMIT 1`,
    [scope.organizationId, connectionSlug, feedKey],
  )) as unknown as Array<{ id: number }>;
  if (rows.length === 0) {
    throw new Error(`virtual feed '${ref}' not found or not accessible`);
  }
  return rows[0].id;
}

/**
 * Classify a connector/pushdown failure for a hard (thrown) error. Prefers the
 * structured `httpStatus` the connector executor propagates (from the SDK's
 * HttpStatusError, lobu#2051 Item 2) over message matching, so a 429/5xx is
 * honestly retryable. Falls back to the message; an otherwise-unclassifiable
 * broken feed/connector run is UPSTREAM_5XX by default.
 */
export function classifyPushdownFailure(err: unknown): ToolErrorCode {
  const httpStatus =
    err && typeof err === 'object' && typeof (err as { httpStatus?: unknown }).httpStatus === 'number'
      ? (err as { httpStatus: number }).httpStatus
      : undefined;
  const code = classifyToolError({ httpStatus, message: getErrorMessage(err) });
  return code === 'INTERNAL' ? 'UPSTREAM_5XX' : code;
}

/**
 * A soft-error result (lobu#2051 Item 2). `code` defaults to `VALIDATION` because
 * every non-DB-catch call site here is an argument/scope fault (bad column, unknown
 * org, malformed query) — none of those are retryable. The DB catch and the
 * timeout path pass explicit codes.
 */
function errorResult(
  message: string,
  startTime: number,
  code: ToolErrorCode = 'VALIDATION'
): QuerySqlResult {
  return {
    rows: [],
    columns: [],
    total_count: 0,
    has_more: false,
    execution_time_ms: Date.now() - startTime,
    error: message,
    error_code: code,
    retryable: isRetryable(code),
  };
}

function querySdkExample(feeds: SuggestedVirtualFeed[]): string {
  const ids = feeds.map((feed) => feed.feed_id).join(', ');
  // Keep this shape in sync with FeedsNamespace.readMany.
  return `export default async (_ctx, client) => {
  return client.feeds.readMany({ feed_ids: [${ids}], limit: ${VIRTUAL_FEED_SUGGESTED_LIMIT} });
};`;
}

async function virtualFeedCoverageForEventsQuery(
  tableRefs: string[],
  scope: AuthzScope
): Promise<QuerySqlCoverage | undefined> {
  if (!tableRefs.includes('events')) return undefined;

  try {
    const sql = getDb();
    const vis = compileConnectionRowVisibility(scope, 'c');
    const rows = (await sql.unsafe(
      `SELECT
         f.id AS feed_id,
         f.feed_key,
         f.display_name,
         c.slug AS connection_slug,
         c.connector_key
       FROM feeds f
       JOIN connections c ON c.id = f.connection_id
       WHERE f.organization_id = $1
         AND f.deleted_at IS NULL
         AND c.deleted_at IS NULL
         AND f.status = 'active'
         AND c.status = 'active'
         AND (f.kind = 'virtual' OR f.virtual IS TRUE)
         ${vis}
       ORDER BY f.id ASC
       LIMIT ${MAX_SUGGESTED_VIRTUAL_FEEDS + 1}`,
      [scope.organizationId],
    )) as unknown as Array<{
      feed_id: number;
      feed_key: string;
      display_name: string | null;
      connection_slug: string;
      connector_key: string;
    }>;

    if (rows.length === 0) return undefined;
    const suggested = rows.slice(0, MAX_SUGGESTED_VIRTUAL_FEEDS).map((row) => ({
      feed_id: Number(row.feed_id),
      feed: `${row.connection_slug}/${row.feed_key}`,
      connection_slug: row.connection_slug,
      feed_key: row.feed_key,
      display_name: row.display_name,
      connector_key: row.connector_key,
      suggested_limit: VIRTUAL_FEED_SUGGESTED_LIMIT,
    }));

    return {
      source: 'persisted_events_only',
      warning:
        'SELECT FROM events reads persisted/synced content only. Virtual feeds are live-only and are not included.',
      suggested_virtual_feeds: suggested,
      more_available: rows.length > MAX_SUGGESTED_VIRTUAL_FEEDS,
      suggested_execution: {
        tool: 'query_sdk',
        method: 'client.feeds.readMany',
        latency_note:
          'Live feed reads are network-bound; run independent feeds in parallel and keep per-feed limits small.',
        example: querySdkExample(suggested),
      },
    };
  } catch (err) {
    logger.warn({ err }, 'query_sql virtual feed coverage lookup failed');
    return undefined;
  }
}

export const querySql = withValidatedArgs('query_sql', QuerySqlSchema, querySqlImpl);

export async function querySqlImpl(
  args: QuerySqlArgs,
  _env: unknown,
  ctx: ToolContext
): Promise<QuerySqlResult> {
  const startTime = Date.now();
  const title = args.title?.trim() || undefined;
  const fail = (message: string, code?: ToolErrorCode): QuerySqlResult => ({
    ...(title ? { title } : {}),
    ...errorResult(message, startTime, code),
  });

  const baseSql = (args.sql ?? '').trim();
  // `feed` runs a STORED query, so caller `sql` is optional there; every other
  // path requires it. `sql` is optional at the SCHEMA level (so a feed call needs
  // no dummy sql), so this presence check moved here from the typebox boundary —
  // but it stays a hard REJECT (throw), not a structured { error }, preserving the
  // "missing sql rejects at the tool boundary, naming the field" contract.
  if (!baseSql && !args.feed) {
    throw new ToolUserError('query_sql requires `sql` (or a `feed` to read).', 400, 'VALIDATION');
  }

  // The base query is wrapped as `SELECT * FROM (<sql>) _t [ORDER BY …] LIMIT …`,
  // so an ORDER BY / LIMIT / window inside the caller's SQL is valid (it sits in
  // the subquery). A derived view's backing_sql commonly has `OVER (ORDER BY …)`.

  // sort_by is optional: omit it for a view whose columns aren't known upfront.
  if (args.sort_by !== undefined && !COLUMN_NAME_RE.test(args.sort_by)) {
    return fail(`Invalid sort_by column name: ${args.sort_by}`);
  }

  // search_columns only filters in concert with search_term — passing it alone
  // is a silent no-op on both the internal and external paths, which reads as
  // "a filter was applied" when none was. Reject it so the caller notices.
  if (args.search_columns?.length && !args.search_term) {
    return fail(
      'search_columns has no effect without search_term — set search_term to filter, or drop search_columns.'
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
        return fail(
          '`org_slug` is not allowed on /mcp/{slug} connections. Reconnect to /mcp to query a different workspace, or omit `org_slug`.'
        );
      }
      return fail(
        '`org_slug` requires an OAuth session on /mcp. PAT and session auth pin to a single org.'
      );
    }
    if (!ctx.userId) {
      return fail('`org_slug` requires an authenticated user context.');
    }
    const targetOrg = await getCachedOrgBySlug(args.org_slug);
    if (!targetOrg) {
      return fail(`Organization '${args.org_slug}' not found.`);
    }
    const role = await getCachedMembershipRole(targetOrg.id, ctx.userId);
    if (role === null) {
      return fail(`Not a member of organization '${args.org_slug}'.`);
    }
    targetOrgId = targetOrg.id;
    // Reaching into ANOTHER workspace stays owner/admin-only. Passing your OWN
    // org slug is just an explicit form of the default and stays read-tier —
    // don't reject a member or silently escalate them to admin. Either way the
    // role is re-validated against the *target* org, not the bound-org role.
    if (targetOrg.id !== ctx.organizationId) {
      if (role !== 'owner' && role !== 'admin') {
        return fail(
          `Cross-org query_sql requires owner or admin access in '${args.org_slug}'.`
        );
      }
      callerIsAdmin = true; // cross-org already required owner/admin in the target
    } else {
      callerIsAdmin = isAdminOrOwnerRole(role);
    }
  }

  if (args.feed && args.connection) {
    return fail('Pass either `feed` or `connection`, not both.');
  }

  // Virtual-feed pushdown: `feed` names a virtual feed whose STORED query runs
  // LIVE against its source (caller `sql` is ignored — the query is authored on
  // the feed). `search_term` narrows via the connector's search(). Same
  // AuthzScope connection-visibility gate readVirtualFeed re-checks; the feed-ref
  // resolution below applies it too. This is strictly tighter than the
  // `connection` pushdown — no arbitrary caller SQL.
  if (args.feed) {
    const bounds = coercePageBounds(args);
    if ('error' in bounds) return fail(bounds.error);
    const { limit, offset } = bounds;
    const scope = authzScopeFromToolContext({ organizationId: targetOrgId, userId: ctx.userId });
    let feedId: number;
    try {
      feedId = await resolveVirtualFeedId(args.feed, scope);
    } catch (err) {
      throw new ToolUserError(getErrorMessage(err), 404, 'NOT_FOUND');
    }
    try {
      const r = await readVirtualFeed({
        scope,
        feedId,
        terms: args.search_term ? [args.search_term] : undefined,
        limit,
        offset,
        sort: args.sort_by
          ? { column: args.sort_by, order: args.sort_order === 'desc' ? 'desc' : 'asc' }
          : undefined,
      });
      return {
        ...(title ? { title } : {}),
        rows: r.rows,
        columns: r.columns,
        total_count: r.total ?? r.rows.length,
        has_more: r.total !== undefined ? offset + limit < r.total : r.rows.length >= limit,
        execution_time_ms: Date.now() - startTime,
      };
    } catch (err) {
      // A broken feed must surface as a hard tool error (MCP isError), never a
      // success-shaped empty table an agent could read as "no data" (#2042).
      throw new ToolUserError(
        `virtual feed read failed (feed=${args.feed}): ${getErrorMessage(err)}. ` +
          'The feed itself is broken or its connector cannot run — this is not an empty result. ' +
          'Check the connector with client.connections.test, or client.feeds.get for feed config.',
        502,
        classifyPushdownFailure(err)
      );
    }
  }

  // External pushdown: when a connection is named, the SQL runs LIVE against that
  // connection's database via its connector (no internal org-scoping — it's the
  // org's own DB, read-only). The connection is resolved org-scoped inside
  // runConnectorQuery; access is bounded by the connection's read-only DB role.
  if (args.connection) {
    if (args.search_term) {
      return fail(
        'search_term is not supported with an external connection — use search_memory.'
      );
    }
    const bounds = coercePageBounds(args);
    if ('error' in bounds) return fail(bounds.error);
    const { limit, offset } = bounds;
    try {
      const r = await runConnectorQuery({
        scope: authzScopeFromToolContext({ organizationId: targetOrgId, userId: ctx.userId }),
        isAdmin: callerIsAdmin,
        connectionSlug: args.connection,
        query: baseSql,
        limit,
        offset,
        sort: args.sort_by
          ? { column: args.sort_by, order: args.sort_order === 'desc' ? 'desc' : 'asc' }
          : undefined,
      });
      return {
        ...(title ? { title } : {}),
        sql: baseSql,
        rows: r.rows,
        columns: r.columns,
        total_count: r.total ?? r.rows.length,
        has_more: r.total !== undefined ? offset + limit < r.total : r.rows.length >= limit,
        execution_time_ms: Date.now() - startTime,
      };
    } catch (err) {
      // Same contract as the feed branch: a pushdown failure is a hard tool
      // error, never a success-shaped empty table (#2042).
      throw new ToolUserError(
        `connection pushdown failed (connection=${args.connection}): ${getErrorMessage(err)}. ` +
          'The query did not run against the source — this is not an empty result.',
        502,
        classifyPushdownFailure(err)
      );
    }
  }

  // Validate, parse, and org-scope the query
  let scopedSql: string;
  let params: unknown[];
  let tableRefs: string[];
  try {
    const scoped = validateAndScopeQuery(baseSql, targetOrgId, {
      safeColumns: SAFE_COLUMN_DEFS,
      restrictedTables: callerIsAdmin ? undefined : ADMIN_ONLY_QUERYABLE_TABLES,
      // Per-user connection visibility: even an admin sees another user's
      // PRIVATE-connection events only when org-visible. Cross-org reuses the
      // same global user id, re-validated against the target org above.
      userId: ctx.userId,
    });
    scopedSql = scoped.sql;
    params = scoped.params;
    tableRefs = scoped.tableRefs;
  } catch (err) {
    return fail(getErrorMessage(err));
  }

  // Build search WHERE clause
  let searchWhere = '';
  if (args.search_term) {
    if (!args.search_columns?.length) {
      return fail('search_columns is required when search_term is set.');
    }
    for (const col of args.search_columns) {
      if (!COLUMN_NAME_RE.test(col)) {
        return fail(`Invalid search column name: ${col}`);
      }
    }
    const searchParamRef = `$${params.length + 1}`;
    params.push(`%${args.search_term.toLowerCase()}%`);
    const orClauses = args.search_columns.map((col) => `lower("${col}") LIKE ${searchParamRef}`);
    searchWhere = `WHERE (${orClauses.join(' OR ')})`;
  }

  const sortOrder = args.sort_order === 'desc' ? 'DESC' : 'ASC';
  const bounds = coercePageBounds(args);
  if ('error' in bounds) return fail(bounds.error);
  const { limit, offset } = bounds;

  const orderBy = args.sort_by ? `ORDER BY "${args.sort_by}" ${sortOrder}` : '';
  // Single execution: the scoped subquery can be expensive (derived entity views
  // aggregate large event ranges), so run it ONCE and take the total from a
  // window count instead of a second full `SELECT count(*) FROM (subquery)`
  // pass. Windows evaluate before LIMIT, so the count covers the full filtered
  // set exactly like the old separate COUNT did. Two fallbacks keep the exact
  // legacy contract: an empty/out-of-range page carries no row to bear the
  // window count (run the explicit COUNT then), and if the caller's own query
  // projects a column named like the internal window alias, re-run the plain
  // two-query shape rather than clobber their column.
  const TOTAL_COL = '__lobu_total_count__';
  const countSql = `SELECT count(*)::int AS c FROM (${scopedSql}) AS _t ${searchWhere}`;
  const dataSql = `SELECT *, COUNT(*) OVER () AS "${TOTAL_COL}" FROM (${scopedSql}) AS _t ${searchWhere} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
  const plainDataSql = `SELECT * FROM (${scopedSql}) AS _t ${searchWhere} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

  try {
    const sql = getDb();
    // Race the DB transaction against the sandbox abort signal so the handler
    // returns promptly when the script times out. The 5s `statement_timeout`
    // is the actual hard cap on the postgres side (postgres.js doesn't expose
    // an AbortSignal hook); raceAbort just unblocks the awaiting caller.
    const txPromise = sql.begin(async (tx: typeof sql) => {
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL statement_timeout = '5s'`;
      const data = await tx.unsafe(dataSql, params);
      const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      // Duplicate TOTAL_COL in the result columns means the caller's query
      // itself projects that name — fall back to the classic two-query shape
      // so the caller's column survives untouched.
      const aliasCollision =
        ((data as any)?.columns ?? []).filter((col: { name: string }) => col.name === TOTAL_COL)
          .length > 1;
      if (rows.length === 0 || aliasCollision) {
        const cnt = await tx.unsafe(countSql, params);
        const totalCount = Number(cnt[0]?.c ?? 0);
        if (aliasCollision) {
          const plain = await tx.unsafe(plainDataSql, params);
          return {
            rows: plain,
            columns: (plain as any)?.columns,
            totalCount,
            columnsHaveWindowCol: false,
          };
        }
        // Empty page: columns still come from the window query, so the
        // internal alias must be stripped from them too.
        return { rows, columns: (data as any)?.columns, totalCount, columnsHaveWindowCol: true };
      }
      return {
        rows,
        columns: (data as any)?.columns,
        totalCount: Number(rows[0][TOTAL_COL]) || 0,
        stripWindowCol: true,
        columnsHaveWindowCol: true,
      };
    });
    const result = await raceAbort(txPromise, ctx.abortSignal);

    const rawRows = result.rows as Array<Record<string, unknown>>;
    const totalCount = result.totalCount;
    const rows = result.stripWindowCol
      ? rawRows.map((row) => {
          const { [TOTAL_COL]: _total, ...rest } = row;
          return rest;
        })
      : rawRows;

    const columns = (result.columns ?? [])
      .filter((col: { name: string }) => !(result.columnsHaveWindowCol && col.name === TOTAL_COL))
      .map(
        (col: { name: string; type: number }) => ({
          name: col.name,
          type: oidToTypeName(col.type),
        })
      );

    const executionTimeMs = Date.now() - startTime;
    if (executionTimeMs >= SLOW_QUERY_COST_MS) {
      logger.warn(
        {
          org_id: targetOrgId,
          user_id: ctx.userId,
          execution_time_ms: executionTimeMs,
          row_count: rows.length,
          total_count: totalCount,
          tables: tableRefs,
        },
        'query_sql slow/expensive query (cost ledger)'
      );
    }
    return {
      ...(title ? { title } : {}),
      sql: baseSql,
      rows,
      columns,
      total_count: totalCount,
      has_more: offset + limit < totalCount,
      execution_time_ms: executionTimeMs,
      coverage: await virtualFeedCoverageForEventsQuery(
        tableRefs,
        authzScopeFromToolContext({ organizationId: targetOrgId, userId: ctx.userId }),
      ),
    };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error({ error }, 'query_sql error');

    // Classify via SQLSTATE where available (57014 = statement timeout), falling
    // back to message matching. The `error_code`/`retryable` fields let the agent
    // distinguish a transient timeout (worth retrying) from a permanent SQL fault.
    const pgCode = (error as { code?: string } | null)?.code;
    if (pgCode === '57014' || msg.includes('timeout') || msg.includes('statement timeout')) {
      return fail('Query exceeded the 5 second timeout.', 'UPSTREAM_TIMEOUT');
    }
    if (msg.includes('read-only')) {
      return fail('Only read-only queries are allowed.', 'VALIDATION');
    }
    return fail(msg, classifyToolError({ pgCode: pgCode ?? undefined, message: msg }));
  }
}
