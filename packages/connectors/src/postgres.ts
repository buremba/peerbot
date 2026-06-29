/**
 * PostgreSQL Connector (V1 runtime)
 *
 * Brings a user's own Postgres database in as memory. A `query` feed runs a
 * user-authored read-only SELECT on a schedule and emits one event per row.
 *
 * Design (see plan §A):
 *  - Auth is `env_keys` with a single `DATABASE_URL` secret → `ctx.config.DATABASE_URL`.
 *  - The user writes a BARE base SELECT (no WHERE-cursor / ORDER BY / LIMIT). The
 *    connector structurally checks it (single statement, leading SELECT/WITH, no
 *    top-level LIMIT/OFFSET, no positional/named params — the read-only tx is the
 *    real write seal) and WRAPS it — never string-substitutes a cursor — with a
 *    keyset compound-cursor predicate so incremental sync is correct across
 *    equal-cursor ties:
 *      SELECT * FROM (<base>) q
 *      WHERE (q.cur > $1 OR (q.cur = $1 AND q.pk > $2))
 *      ORDER BY q.cur, q.pk LIMIT $3
 *  - Cursor/pk column TYPES are introspected via a `LIMIT 0` probe so the
 *    checkpoint value (round-tripped through jsonb as a string) is re-cast to the
 *    right Postgres type — timestamptz / bigint / uuid all survive.
 *  - origin_id = "<feed>:<pk>" so two feeds on one connection never collide, and
 *    re-emitting a row supersedes (events ingestion dedupes by origin_id).
 *
 * V1 trust model (plan §G): the DATABASE_URL host is checked before connecting
 * (guardDbHost → db-egress-guard). Under the default `allow-private` policy
 * (first-party / operator-set URL) private IPs are allowed — the dogfood reaches
 * Lobu's own private PG — and only metadata/link-local literals are blocked.
 * Under `block-private` (injected by the server in cloud mode) every non-public
 * host is rejected. Untrusted multi-tenant cloud exposure is ALSO gated
 * separately (the bundled connector is restricted under LOBU_CLOUD_MODE) until
 * the full hardening (IP pin / force-TLS) lands and that gate is lifted.
 */

import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type QueryContext,
  type QueryResult,
  type SearchContext,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';
import postgres from 'postgres';
import { assertConnectionStringAllowed, readEgressPolicy } from './db-egress-guard.js';

interface PgQueryConfig {
  /** ONE read-only base SELECT. No WHERE-cursor / ORDER BY / top-level LIMIT — the connector wraps it. */
  query: string;
  /** Result column → EventEnvelope.origin_id (combined with the feed key). Must be a simple identifier. */
  primary_key: string;
  /** Monotonic result column for the incremental watermark. Required in V1 (strictly-incremental only). */
  cursor_column: string;
  /** Optional column → event-field overrides. Result columns named like the fields auto-map. */
  mapping?: {
    title?: string;
    author_name?: string;
    occurred_at?: string;
    payload_text?: string;
    source_url?: string;
  };
  /** Hard cap on rows pulled per sync run. Default 5000. */
  max_rows_per_sync?: number;
  /** Per-query timeout in ms. Default 30000. */
  statement_timeout_ms?: number;
}

interface PgCheckpoint {
  /** Last cursor value seen, serialized (ISO for dates, String() otherwise). */
  last_cursor?: string;
  /** Last primary-key value seen, serialized. */
  last_pk?: string;
}

const configSchema = {
  type: 'object',
  required: ['query', 'primary_key', 'cursor_column'],
  properties: {
    query: {
      type: 'string',
      description:
        'A read-only base SELECT. Do NOT add a WHERE on the cursor, an ORDER BY, or a LIMIT — the connector adds keyset pagination automatically. Alias mixed-case columns to simple names, and give every output column a distinct name (duplicate names collapse in the row object).',
    },
    primary_key: {
      type: 'string',
      description: 'Result column that uniquely identifies a row (becomes the event origin id).',
    },
    cursor_column: {
      type: 'string',
      description:
        'A monotonically non-decreasing, NOT NULL result column (e.g. created_at, id) used as the incremental watermark.',
    },
    mapping: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        author_name: { type: 'string' },
        occurred_at: { type: 'string' },
        payload_text: { type: 'string' },
        source_url: { type: 'string' },
      },
    },
    max_rows_per_sync: { type: 'integer', minimum: 1, maximum: 50000, default: 5000 },
    statement_timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, default: 30000 },
  },
};

/**
 * Postgres type OID → `cast` (SQL cast we re-apply to a string-bound checkpoint
 * value) and `display` (human type name surfaced on query() columns). The two
 * diverge for the integer/bool OIDs — `::int8` is the cast syntax, `bigint` is
 * the name — so the display column matches query_sql's PG_OID_TYPE_MAP rather
 * than leaking cast aliases (int8/int4/bool) to callers.
 */
const PG_OID: Record<number, { cast: string; display: string }> = {
  1184: { cast: 'timestamptz', display: 'timestamptz' },
  1114: { cast: 'timestamp', display: 'timestamp' },
  1082: { cast: 'date', display: 'date' },
  1083: { cast: 'time', display: 'time' },
  1186: { cast: 'interval', display: 'interval' },
  20: { cast: 'int8', display: 'bigint' },
  23: { cast: 'int4', display: 'integer' },
  21: { cast: 'int2', display: 'smallint' },
  26: { cast: 'oid', display: 'oid' },
  1700: { cast: 'numeric', display: 'numeric' },
  700: { cast: 'float4', display: 'float4' },
  701: { cast: 'float8', display: 'float8' },
  25: { cast: 'text', display: 'text' },
  1043: { cast: 'varchar', display: 'varchar' },
  1042: { cast: 'bpchar', display: 'bpchar' },
  19: { cast: 'name', display: 'name' },
  2950: { cast: 'uuid', display: 'uuid' },
  16: { cast: 'bool', display: 'boolean' },
  17: { cast: 'bytea', display: 'bytea' },
  114: { cast: 'json', display: 'json' },
  3802: { cast: 'jsonb', display: 'jsonb' },
};

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

function assertIdentifier(value: string, label: string): string {
  if (!IDENT_RE.test(value)) {
    throw new Error(
      `${label} must be a simple identifier (got "${value}"). Alias mixed-case/expression columns to a simple name in your SELECT.`,
    );
  }
  return value;
}

/** Double embedded quotes so a probed column name is safe inside `q."…"`. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Escape LIKE/ILIKE wildcards so a user search term matches literally — the
 * default Postgres escape char is backslash, so `\%` / `\_` / `\\` are literals.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * True if `sql` has a `LIMIT`/`OFFSET` keyword at paren-depth 0 (a TOP-level
 * one), scanning past string literals, quoted identifiers, and comments so a
 * `'limit'` literal or a `"limit"` column never false-matches. An inner LIMIT
 * inside a subquery sits at depth > 0 and is allowed. Works without the AST, so
 * it gates both the parseable and the token-fallback paths identically.
 */
function hasTopLevelLimitOrOffset(sql: string): boolean {
  const n = sql.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      i++;
      while (i < n && sql[i] !== "'") i++;
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && sql[i] !== '"') i++;
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      if (depth === 0) {
        const word = sql.slice(i, j).toLowerCase();
        if (word === 'limit' || word === 'offset') return true;
      }
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Shared read-only gate for both the memory feed (sync) and live query(). It is
 * a structural check, NOT a SQL parser: the HARD write seal is the read-only
 * transaction (`SET TRANSACTION READ ONLY`), which rejects every write — incl. a
 * data-modifying CTE — at execution; and the connector always runs the query as
 * `SELECT * FROM (<sql>) q …`, so a top-level data-modifying CTE is also a syntax
 * error (Postgres forbids it inside a subquery). So this only enforces what makes
 * the wrap valid and the cursor correct:
 *  - one statement (no embedded `;`), no bind params (the connector binds its own);
 *  - it reads (`SELECT`, or `WITH … SELECT`, or a parenthesized select) — not a
 *    leading `SET`/`CALL`/`DO`/DDL that a read-only tx would still happily run;
 *  - no TOP-level LIMIT/OFFSET — the connector wraps + paginates on the outside,
 *    so a top-level LIMIT would (sync) stall the keyset cursor and (live) cap the
 *    universe the OFFSET pages over. An inner LIMIT inside a subquery is fine.
 *
 * Deliberately no AST parser: a Postgres-grammar parser lags real Postgres and
 * would false-reject valid SQL (FTS `@@`, jsonpath, `GROUPING SETS`, …) while
 * adding nothing the read-only transaction doesn't already guarantee.
 */
function validateReadOnlySelect(raw: string): string {
  const stripped = raw.trim().replace(/;\s*$/, '');
  if (!stripped) throw new Error('query is empty');
  if (stripped.includes(';')) {
    throw new Error('query must be a single statement (no embedded ";").');
  }
  if (/\$\d/.test(stripped) || /(^|[^:]):[A-Za-z_]/.test(stripped)) {
    throw new Error('query must not contain bind parameters ($1, :name).');
  }
  // Allow a leading "(" for "(SELECT …) UNION …" / parenthesized selects.
  const head = stripped.replace(/^\s*\(+\s*/, '');
  if (!/^(select|with)\b/i.test(head)) {
    throw new Error('query must be a single read-only SELECT (or WITH … SELECT).');
  }
  if (hasTopLevelLimitOrOffset(stripped)) {
    throw new Error(
      'query must not include a top-level LIMIT/OFFSET — the connector adds pagination automatically (an inner LIMIT inside a subquery is fine).',
    );
  }
  return stripped;
}

/** postgres.js client options shared by sync() and query(): a tiny capped pool
 *  that never prepares (so `.unsafe` simple-protocol queries work) and swallows
 *  NOTICEs so a connection string can never reach a log line. */
const POOL_OPTS = {
  max: 2,
  idle_timeout: 5,
  connect_timeout: 15,
  prepare: false,
  onnotice: () => {},
} as const;

/**
 * SSRF/egress pre-flight, run before any socket opens on BOTH sync() and
 * query(). Policy comes from ctx.config.LOBU_DB_EGRESS_POLICY — the server
 * injects `block-private` under cloud mode; everything else defaults to the
 * trusted `allow-private`. The host parsing + per-host validation (incl. the
 * multi-host failover case) lives in db-egress-guard.
 */
async function guardDbHost(connectionString: string, config: Record<string, unknown>): Promise<void> {
  await assertConnectionStringAllowed(connectionString, readEgressPolicy(config.LOBU_DB_EGRESS_POLICY));
}

/** Seal a transaction read-only with a statement timeout — the hard write/time
 *  boundary both sync() and query() rely on. */
async function setReadOnly(
  tx: { unsafe: (q: string) => Promise<unknown> },
  timeoutMs: number,
): Promise<void> {
  await tx.unsafe('SET TRANSACTION READ ONLY');
  await tx.unsafe(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
}

function toCheckpointValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export default class PostgresConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'postgres',
    name: 'PostgreSQL',
    description: 'Bring your own PostgreSQL database in as memory via a read-only SQL query.',
    version: '1.0.0',
    faviconDomain: 'postgresql.org',
    authSchema: {
      methods: [
        {
          type: 'env_keys',
          required: true,
          scope: 'connection',
          fields: [
            {
              key: 'DATABASE_URL',
              label: 'PostgreSQL connection string',
              description: 'postgres://user:pass@host:5432/db — use a least-privilege READ-ONLY role.',
              secret: true,
              required: true,
            },
          ],
        },
      ],
    },
    feeds: {
      query: {
        key: 'query',
        name: 'SQL Query',
        description: 'Ingest rows from a read-only SELECT as memory, incrementally by a cursor column.',
        // Every instance carries a required user-authored query, so it cannot be auto-wired.
        userManaged: true,
        configSchema,
        displayNameTemplate: '{name}',
        eventKinds: {
          row: {
            description: 'A row returned by the configured SQL query.',
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const connectionString = ctx.config.DATABASE_URL as string | undefined;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }
    const config = ctx.config as unknown as PgQueryConfig;

    const baseSql = validateReadOnlySelect(config.query);
    const cursorCol = assertIdentifier(config.cursor_column, 'cursor_column');
    const pkCol = assertIdentifier(config.primary_key, 'primary_key');
    const limit = Math.min(Math.max(config.max_rows_per_sync ?? 5000, 1), 50000);
    const timeoutMs = Math.min(Math.max(config.statement_timeout_ms ?? 30000, 1000), 600000);

    const checkpoint = (ctx.checkpoint as PgCheckpoint | null) ?? {};

    await guardDbHost(connectionString, ctx.config as Record<string, unknown>);
    const sql = postgres(connectionString, POOL_OPTS);

    try {
      // Everything runs inside ONE read-only transaction — the probe included —
      // so even a crafted query (e.g. a data-modifying CTE that slipped past
      // validation) cannot write while we introspect or read.
      const rows = (await sql.begin(async (tx) => {
        await setReadOnly(tx, timeoutMs);

        // 1. Probe column types so the string-serialized checkpoint can be re-cast.
        const probe = await tx.unsafe(`SELECT * FROM (\n${baseSql}\n) q LIMIT 0`);
        const cols =
          (probe as unknown as { columns?: Array<{ name: string; type: number }> }).columns ?? [];
        const colByName = new Map(cols.map((c) => [c.name, c]));
        if (cols.length > 0 && !colByName.has(cursorCol)) {
          throw new Error(`cursor_column "${cursorCol}" is not a column in the query result.`);
        }
        if (cols.length > 0 && !colByName.has(pkCol)) {
          throw new Error(`primary_key "${pkCol}" is not a column in the query result.`);
        }
        const castFor = (name: string): string => {
          const t = colByName.get(name)?.type;
          const cast = t !== undefined ? PG_OID[t]?.cast : undefined;
          return cast ? `::${cast}` : '';
        };
        const curCast = castFor(cursorCol);
        const pkCast = castFor(pkCol);

        // 2. Build the keyset-paginated query.
        const colCur = `q."${cursorCol}"`;
        const colPk = `q."${pkCol}"`;
        const haveCursor =
          checkpoint.last_cursor !== undefined && checkpoint.last_pk !== undefined;

        let wrapped: string;
        let params: unknown[];
        if (haveCursor) {
          // security-allowed: colCur/colPk are assertIdentifier-validated + quoted;
          // the cursor/pk values are bound parameters ($1/$2/$3), not interpolated.
          wrapped =
            `SELECT * FROM (\n${baseSql}\n) q\n` +
            `WHERE (${colCur} > $1${curCast} ` +
            `OR (${colCur} = $1${curCast} AND ${colPk} > $2${pkCast}))\n` +
            `ORDER BY ${colCur}, ${colPk} LIMIT $3`;
          params = [checkpoint.last_cursor, checkpoint.last_pk, limit];
        } else {
          wrapped = `SELECT * FROM (\n${baseSql}\n) q\nORDER BY ${colCur}, ${colPk} LIMIT $1`;
          params = [limit];
        }

        return tx.unsafe(wrapped, params as never[]);
      })) as unknown as Array<Record<string, unknown>>;

      // Namespace origin_ids by the feed INSTANCE, not the feed key: every
      // postgres feed shares feedKey 'query', so two feeds on one connection with
      // overlapping primary keys would otherwise emit the same origin_id and
      // supersede each other's events. feedId is unique per feeds row; fall back
      // to feedKey only for direct/programmatic sync calls (no feedId).
      const originPrefix = ctx.feedId != null ? String(ctx.feedId) : ctx.feedKey;

      // Map rows → events, advancing the compound checkpoint to the last row.
      const events: EventEnvelope[] = [];
      let newCheckpoint: PgCheckpoint = checkpoint;
      for (const row of rows) {
        events.push(this.rowToEvent(originPrefix, row, config, cursorCol, pkCol));
        newCheckpoint = {
          last_cursor: toCheckpointValue(row[cursorCol]),
          last_pk: toCheckpointValue(row[pkCol]),
        };
      }

      return {
        events,
        checkpoint: newCheckpoint as unknown as Record<string, unknown>,
        metadata: { items_found: events.length },
      };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Live read (no copy): run `ctx.query` read-only against the source and return
   * rows. The platform calls this for virtual-feed reads and external-backed
   * derived entities. An inner ORDER BY/LIMIT inside a subquery is fine — it's
   * wrapped and paginated on the outside; a TOP-level LIMIT is rejected by
   * validateReadOnlySelect because the outer OFFSET would page over a capped set.
   */
  async query(ctx: QueryContext): Promise<QueryResult> {
    const connectionString = (ctx.config as Record<string, unknown>).DATABASE_URL as
      | string
      | undefined;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }
    const baseSql = validateReadOnlySelect(ctx.query);
    const limit =
      ctx.limit !== undefined ? Math.min(Math.max(Math.trunc(ctx.limit), 1), 5000) : 1000;
    const offset = ctx.offset !== undefined ? Math.max(Math.trunc(ctx.offset), 0) : 0;
    let orderBy = '';
    if (ctx.sort?.column) {
      const col = assertIdentifier(ctx.sort.column, 'sort.column');
      orderBy = `ORDER BY q."${col}" ${ctx.sort.order === 'desc' ? 'DESC' : 'ASC'}`;
    }
    const wrapped = `SELECT * FROM (\n${baseSql}\n) q\n${orderBy}\nLIMIT ${limit} OFFSET ${offset}`;
    // Real total over the whole (un-paginated) result, so the aggregator reports
    // an accurate total_count / has_more — parity with the internal query_sql
    // path. baseSql has no top-level LIMIT (rejected above), so this is exact.
    const countSql = `SELECT count(*)::int AS n FROM (\n${baseSql}\n) q`;

    await guardDbHost(connectionString, ctx.config as Record<string, unknown>);
    const sql = postgres(connectionString, POOL_OPTS);
    try {
      const { data, total } = (await sql.begin(async (tx) => {
        await setReadOnly(tx, 30000);
        const rows = await tx.unsafe(wrapped);
        const counted = (await tx.unsafe(countSql)) as unknown as Array<{ n: number }>;
        return { data: rows, total: counted[0]?.n };
      })) as unknown as {
        data: Array<Record<string, unknown>> & { columns?: Array<{ name: string; type: number }> };
        total: number | undefined;
      };
      const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      const cols = data.columns ?? [];
      const names = cols.map((c) => c.name);
      if (new Set(names).size !== names.length) {
        throw new Error(
          'query has duplicate output column names — alias each selected column to a distinct name (the row object would otherwise drop a value).',
        );
      }
      const columns = cols.map((c) => ({ name: c.name, type: PG_OID[c.type]?.display ?? 'unknown' }));
      return { rows, columns, total };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  /**
   * Virtual-feed RECALL: live read with the caller's keyword `terms` pushed DOWN
   * as an `ILIKE` predicate over the validated subquery, inside the SAME
   * read-only transaction + egress guard as query(). The output columns are
   * probed (LIMIT 0) so each term is matched against EVERY column cast to text;
   * a row matches when every term hits at least one column. Terms are bound
   * parameters (never interpolated) and wildcard-escaped, so a term like `50%`
   * matches literally. Empty `terms` ⇒ behaves like query() (no predicate).
   */
  async search(ctx: SearchContext): Promise<QueryResult> {
    const connectionString = (ctx.config as Record<string, unknown>).DATABASE_URL as
      | string
      | undefined;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }
    const baseSql = validateReadOnlySelect(ctx.query);
    const terms = (ctx.terms ?? []).map((t) => t.trim()).filter(Boolean);
    const limit =
      ctx.limit !== undefined ? Math.min(Math.max(Math.trunc(ctx.limit), 1), 5000) : 1000;
    const offset = ctx.offset !== undefined ? Math.max(Math.trunc(ctx.offset), 0) : 0;
    let orderBy = '';
    if (ctx.sort?.column) {
      const col = assertIdentifier(ctx.sort.column, 'sort.column');
      orderBy = `ORDER BY q."${col}" ${ctx.sort.order === 'desc' ? 'DESC' : 'ASC'}`;
    }

    await guardDbHost(connectionString, ctx.config as Record<string, unknown>);
    const sql = postgres(connectionString, POOL_OPTS);
    try {
      const { data, columns, total } = (await sql.begin(async (tx) => {
        await setReadOnly(tx, 30000);
        // Probe output columns so recall spans every column (cast to text).
        const probe = await tx.unsafe(`SELECT * FROM (\n${baseSql}\n) q LIMIT 0`);
        const cols =
          (probe as unknown as { columns?: Array<{ name: string; type: number }> }).columns ?? [];
        const names = cols.map((c) => c.name);
        if (new Set(names).size !== names.length) {
          throw new Error(
            'query has duplicate output column names — alias each selected column to a distinct name (the row object would otherwise drop a value).',
          );
        }

        // Each term → an OR across all columns; terms AND together. Terms are
        // bound params ($1..$n); column identifiers come from the live result
        // set and are quote-escaped. No columns or no terms ⇒ no predicate.
        const params: unknown[] = [];
        let whereClause = '';
        if (terms.length > 0 && names.length > 0) {
          const perTerm = terms.map((term) => {
            params.push(`%${escapeLike(term)}%`);
            const idx = params.length;
            const ors = names.map((n) => `q.${quoteIdent(n)}::text ILIKE $${idx}`).join(' OR ');
            return `(${ors})`;
          });
          whereClause = `WHERE ${perTerm.join(' AND ')}`;
        }

        const wrapped = `SELECT * FROM (\n${baseSql}\n) q\n${whereClause}\n${orderBy}\nLIMIT ${limit} OFFSET ${offset}`;
        const countSql = `SELECT count(*)::int AS n FROM (\n${baseSql}\n) q\n${whereClause}`;
        const rows = await tx.unsafe(wrapped, params as never[]);
        const counted = (await tx.unsafe(countSql, params as never[])) as unknown as Array<{
          n: number;
        }>;
        return { data: rows, columns: cols, total: counted[0]?.n };
      })) as unknown as {
        data: Array<Record<string, unknown>>;
        columns: Array<{ name: string; type: number }>;
        total: number | undefined;
      };
      const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
      const outCols = columns.map((c) => ({
        name: c.name,
        type: PG_OID[c.type]?.display ?? 'unknown',
      }));
      return { rows, columns: outCols, total };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  private rowToEvent(
    originPrefix: string,
    row: Record<string, unknown>,
    config: PgQueryConfig,
    cursorCol: string,
    pkCol: string,
  ): EventEnvelope {
    const m = config.mapping ?? {};
    const pick = (key: string | undefined, fallbackCol: string): unknown =>
      key ? row[key] : row[fallbackCol];

    const occurredRaw = m.occurred_at ? row[m.occurred_at] : (row.occurred_at ?? row[cursorCol]);
    const titleRaw = pick(m.title, 'title');
    const authorRaw = pick(m.author_name, 'author_name');
    const sourceRaw = pick(m.source_url, 'source_url');
    const payloadText = m.payload_text ? row[m.payload_text] : row.payload_text;

    return {
      origin_id: `${originPrefix}:${String(row[pkCol])}`,
      origin_type: 'row',
      title: titleRaw != null ? String(titleRaw) : undefined,
      author_name: authorRaw != null ? String(authorRaw) : undefined,
      source_url: sourceRaw != null ? String(sourceRaw) : undefined,
      payload_text: payloadText != null ? String(payloadText) : JSON.stringify(row),
      payload_data: row,
      occurred_at: toDate(occurredRaw) ?? new Date(),
    };
  }
}
