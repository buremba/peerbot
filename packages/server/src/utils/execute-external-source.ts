/**
 * Execute a derived entity's `backing_sql` LIVE against an EXTERNAL single
 * database (no copy) — the read side of an external-backed derived entity type
 * (`entity_types.backing_source` = a connection slug). See query_entity_type.
 *
 * This is deliberately NOT execute-data-sources.ts: there is no CTE rewriting and
 * no `organization_id` injection, because the target is the tenant's OWN database,
 * not Lobu's multi-tenant store. The safeguards instead are: a polyglot read-only
 * gate (single statement, SELECT/WITH, no DML/forbidden ops), a READ ONLY
 * transaction, a `statement_timeout`, an outer `LIMIT` row cap, and credential
 * isolation (connection strings never surface in errors/logs).
 *
 * Single-database only (plan §4). Cross-source / multi-DB federation is deferred
 * to an enterprise engine (DuckDB). The `SqlDialectAdapter` seam keeps
 * Snowflake/BigQuery additive — Postgres is the only adapter in V1.
 *
 * Pools are per-pod (no shared state → multi-replica safe); capacity is bounded
 * by EXTERNAL_DB_MAX_POOLS × EXTERNAL_DB_POOL_MAX × replicaCount.
 */

import { ast, Dialect, parse as parseSql } from '@polyglot-sql/sdk';
import postgres, { type Sql } from 'postgres';
import { getDb, PROD_PG_VALUE_OPTIONS } from '../db/client';
import { getAuthProfileById, normalizeAuthValues } from './auth-profiles';
import { isCloudMode } from './cloud-mode';
import { isReadQuery } from './execute-data-sources';
import logger from './logger';
import { COLUMN_NAME_RE, oidToTypeName } from './pg-oid';

export interface ExternalSourceRef {
  organizationId: string;
  /** Connection slug stored in entity_types.backing_source. */
  connectionSlug: string;
}

export interface ExternalQueryOptions {
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** Rows per page (1–500). Default 50. */
  limit?: number;
  offset?: number;
  searchTerm?: string;
  searchColumns?: string[];
}

export interface ExternalQueryResult {
  rows: Record<string, unknown>[];
  columns: { name: string; type: string }[];
  total_count: number;
  has_more: boolean;
}

const FORBIDDEN_OPS = /\b(COPY|IMPORT|PRAGMA|CALL|DO)\b/i;
const POOL_MAX = Number.parseInt(process.env.EXTERNAL_DB_POOL_MAX || '4', 10);
const MAX_POOLS = Number.parseInt(process.env.EXTERNAL_DB_MAX_POOLS || '25', 10);
const POOL_IDLE_MS = 5 * 60 * 1000;
const QUERY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Read-only gate (no allowlist — it's the tenant's own DB)
// ---------------------------------------------------------------------------

const DML_NODE_TYPES = new Set(['insert', 'update', 'delete', 'merge', 'replace']);

/**
 * Walk the parsed AST for any data-modifying statement node — catches a
 * data-modifying CTE (`WITH x AS (INSERT … RETURNING) SELECT …`) that the
 * SELECT/WITH prefix check would otherwise miss. The READ ONLY transaction is
 * the hard seal (Postgres rejects all writes in a read-only tx, CTEs included);
 * this is defense-in-depth that fails the query at parse time with a clear error.
 */
function containsDmlNode(root: unknown): boolean {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node as object)) continue;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    try {
      const t = ast.getExprType(node as ast.Expression);
      if (typeof t === 'string' && DML_NODE_TYPES.has(t)) return true;
    } catch {
      // not an expression node — keep walking its children
    }
    for (const key of Object.keys(node as object)) {
      stack.push((node as Record<string, unknown>)[key]);
    }
  }
  return false;
}

/** Throws unless `sql` is a single read-only SELECT/WITH statement. */
export function assertExternalReadQuery(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) throw new Error('backing SQL is empty');
  if (!isReadQuery(trimmed)) {
    throw new Error('Only SELECT / WITH queries can back an external entity.');
  }
  if (FORBIDDEN_OPS.test(trimmed)) {
    throw new Error('backing SQL contains a forbidden operation.');
  }
  const res = parseSql(trimmed, Dialect.PostgreSQL);
  if (!res.success || !res.ast) {
    throw new Error('backing SQL could not be parsed.');
  }
  const statements = Array.isArray(res.ast) ? res.ast : [res.ast];
  if (statements.length > 1) {
    throw new Error('backing SQL must be a single statement.');
  }
  if (containsDmlNode(res.ast)) {
    throw new Error('backing SQL must not contain data-modifying statements (incl. in CTEs).');
  }
}

// ---------------------------------------------------------------------------
// Credential resolution (connection slug → DATABASE_URL)
// ---------------------------------------------------------------------------

interface ResolvedExternalConn {
  url: string;
  connectorKey: string | null;
}

async function resolveExternalConnection(
  organizationId: string,
  connectionSlug: string
): Promise<ResolvedExternalConn> {
  const db = getDb();
  const rows = await db`
    SELECT id, connector_key, auth_profile_id
    FROM connections
    WHERE organization_id = ${organizationId}
      AND slug = ${connectionSlug}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error(`source connection '${connectionSlug}' no longer exists`);
  }
  const conn = rows[0] as {
    connector_key: string | null;
    auth_profile_id: number | null;
  };
  const profile = await getAuthProfileById(organizationId, conn.auth_profile_id);
  if (!profile || profile.profile_kind !== 'env') {
    throw new Error(`source connection '${connectionSlug}' has no environment credentials`);
  }
  const env = normalizeAuthValues(profile.auth_data);
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(`source connection '${connectionSlug}' is missing DATABASE_URL`);
  }
  return { url, connectorKey: conn.connector_key };
}

// ---------------------------------------------------------------------------
// Per-pod pool registry (capped, idle-evicting, credential-rotation aware)
// ---------------------------------------------------------------------------

interface PoolEntry {
  sql: Sql;
  connString: string;
  lastUsed: number;
}
const pools = new Map<string, PoolEntry>();

function nowMs(): number {
  // performance.now is monotonic and (unlike Date.now) allowed in this codebase's
  // hot paths; we only need relative ordering for LRU + idle eviction.
  return performance.now();
}

function closePool(entry: PoolEntry): void {
  entry.sql.end({ timeout: 5 }).catch((err) => {
    logger.warn({ err: redact(err) }, 'failed closing external db pool');
  });
}

function evictIfNeeded(): void {
  const now = nowMs();
  for (const [key, entry] of pools) {
    if (now - entry.lastUsed > POOL_IDLE_MS) {
      pools.delete(key);
      closePool(entry);
    }
  }
  while (pools.size >= MAX_POOLS) {
    let lruKey: string | null = null;
    let lruAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of pools) {
      if (entry.lastUsed < lruAt) {
        lruAt = entry.lastUsed;
        lruKey = key;
      }
    }
    if (!lruKey) break;
    const entry = pools.get(lruKey);
    pools.delete(lruKey);
    if (entry) closePool(entry);
  }
}

function getPool(key: string, connString: string): Sql {
  const existing = pools.get(key);
  if (existing) {
    if (existing.connString === connString) {
      existing.lastUsed = nowMs();
      return existing.sql;
    }
    // Credential rotated → drop the stale pool and rebuild.
    pools.delete(key);
    closePool(existing);
  }
  evictIfNeeded();
  const sql = postgres(connString, {
    max: POOL_MAX,
    idle_timeout: 30,
    max_lifetime: 60 * 10,
    connect_timeout: 15,
    prepare: false,
    connection: { application_name: 'lobu-external' },
    onnotice: () => {},
    ...PROD_PG_VALUE_OPTIONS,
  }) as unknown as Sql;
  pools.set(key, { sql, connString, lastUsed: nowMs() });
  return sql;
}

/**
 * Strip anything that looks like a connection string from an error before it
 * escapes. Only ever operates on the error MESSAGE (we never log the raw error
 * object), and covers both full `postgres://…` URLs and bare `user:pass@host:port`
 * userinfo that can appear in connection-level errors.
 */
function redact(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/postgres(?:ql)?:\/\/[^\s'"]*/gi, 'postgres://<redacted>')
    .replace(/[\w.+-]+(?::[^@\s/]+)?@[\w.-]+(?::\d+)?/g, '<redacted-host>');
}

// ---------------------------------------------------------------------------
// Dialect seam (Postgres-only in V1; Snowflake/BigQuery add sibling adapters)
// ---------------------------------------------------------------------------

interface SqlDialectAdapter {
  readonly dialect: string;
  /** Read-only-enforcing run of count + data; returns rows, total, and columns. */
  run(
    pool: Sql,
    countSql: string,
    dataSql: string,
    params: unknown[],
    timeoutMs: number
  ): Promise<{ rows: Record<string, unknown>[]; total: number; columns: { name: string; type: string }[] }>;
}

const POSTGRES_ADAPTER: SqlDialectAdapter = {
  dialect: 'postgres',
  async run(pool, countSql, dataSql, params, timeoutMs) {
    const [countResult, dataResult] = await pool.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      await tx.unsafe(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
      const cnt = await tx.unsafe(countSql, params as never[]);
      const data = await tx.unsafe(dataSql, params as never[]);
      return [cnt, data] as const;
    });
    const total = Number((countResult as Array<{ c?: number }>)[0]?.c ?? 0);
    const cols = (dataResult as unknown as { columns?: Array<{ name: string; type: number }> }).columns ?? [];
    const columns = cols.map((c) => ({ name: c.name, type: oidToTypeName(c.type) }));
    return { rows: Array.isArray(dataResult) ? dataResult : [], total, columns };
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `viewSql` against the external database named by `ref`, paginated/sorted/
 * searched per `opts`. The SQL is treated as a subquery, so an inner ORDER BY /
 * LIMIT / window is fine; pagination + sort are added on the outside.
 */
export async function executeExternalSource(
  ref: ExternalSourceRef,
  viewSql: string,
  opts: ExternalQueryOptions = {}
): Promise<ExternalQueryResult> {
  // §G hard gate: a raw external-DB pool opens arbitrary outbound TCP to a
  // tenant-controlled DATABASE_URL — the exact SSRF/exfil vector. Until egress
  // hardening (resolve-then-pin IP, DNS-rebinding guard, internal-CIDR/metadata
  // block) lands, the entire live external-read path is self-hosted only. This
  // is the airtight gate: it covers ALL connections, not just the postgres
  // connector (a tenant could otherwise bind a derived view to any env
  // connection carrying a DATABASE_URL). No-op self-hosted.
  if (isCloudMode()) {
    throw new Error(
      'External database queries are not available on Lobu Cloud yet — they require a self-hosted or single-tenant deployment.'
    );
  }
  assertExternalReadQuery(viewSql);

  if (opts.sortBy !== undefined && !COLUMN_NAME_RE.test(opts.sortBy)) {
    throw new Error(`Invalid sort_by column name: ${opts.sortBy}`);
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(opts.limit ?? 50))));
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)));

  // Search WHERE clause (parameterized, ILIKE) — identical contract to query_sql.
  const params: unknown[] = [];
  let searchWhere = '';
  if (opts.searchTerm) {
    if (!opts.searchColumns?.length) {
      throw new Error('search_columns is required when search_term is set.');
    }
    for (const col of opts.searchColumns) {
      if (!COLUMN_NAME_RE.test(col)) throw new Error(`Invalid search column name: ${col}`);
    }
    params.push(`%${opts.searchTerm.toLowerCase()}%`);
    const ref$ = `$${params.length}`;
    const ors = opts.searchColumns.map((c) => `lower("${c}"::text) LIKE ${ref$}`);
    searchWhere = `WHERE (${ors.join(' OR ')})`;
  }

  const sortOrder = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';
  const orderBy = opts.sortBy ? `ORDER BY "${opts.sortBy}" ${sortOrder}` : '';
  const countSql = `SELECT count(*)::int AS c FROM (${viewSql}) AS _t ${searchWhere}`;
  const dataSql = `SELECT * FROM (${viewSql}) AS _t ${searchWhere} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

  const { url } = await resolveExternalConnection(ref.organizationId, ref.connectionSlug);
  const key = `${ref.organizationId}:${ref.connectionSlug}`;
  const pool = getPool(key, url);

  try {
    const { rows, total, columns } = await POSTGRES_ADAPTER.run(
      pool,
      countSql,
      dataSql,
      params,
      QUERY_TIMEOUT_MS
    );
    return { rows, columns, total_count: total, has_more: offset + limit < total };
  } catch (err) {
    // Never let a connection string escape in an error.
    const safe = redact(err);
    logger.error({ connection: ref.connectionSlug, error: safe }, 'external source query failed');
    if (/timeout|statement timeout/i.test(safe)) {
      throw new Error('QUERY_TIMEOUT: external query exceeded the time limit.');
    }
    throw new Error(`EXTERNAL_QUERY_ERROR: ${safe}`);
  }
}

/** Test hook: close all external pools (used by integration tests). */
export async function __closeAllExternalPools(): Promise<void> {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(entries.map((e) => e.sql.end({ timeout: 5 }).catch(() => {})));
}
