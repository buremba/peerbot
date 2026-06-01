/**
 * PostgreSQL Connector (V1 runtime)
 *
 * Brings a user's own Postgres database in as memory. A `query` feed runs a
 * user-authored read-only SELECT on a schedule and emits one event per row.
 *
 * Design (see plan §A):
 *  - Auth is `env_keys` with a single `DATABASE_URL` secret → `ctx.config.DATABASE_URL`.
 *  - The user writes a BARE base SELECT (no WHERE-cursor / ORDER BY / LIMIT). The
 *    connector validates it with node-sql-parser (single statement, a SELECT, no
 *    top-level LIMIT/OFFSET, no positional/named params) and WRAPS it — never
 *    string-substitutes a cursor — with a keyset compound-cursor predicate so
 *    incremental sync is correct across equal-cursor ties:
 *      SELECT * FROM (<base>) q
 *      WHERE (q.cur > $1 OR (q.cur = $1 AND q.pk > $2))
 *      ORDER BY q.cur, q.pk LIMIT $3
 *  - Cursor/pk column TYPES are introspected via a `LIMIT 0` probe so the
 *    checkpoint value (round-tripped through jsonb as a string) is re-cast to the
 *    right Postgres type — timestamptz / bigint / uuid all survive.
 *  - origin_id = "<feed>:<pk>" so two feeds on one connection never collide, and
 *    re-emitting a row supersedes (events ingestion dedupes by origin_id).
 *
 * V1 trust model (plan §G): first-party / operator-set DATABASE_URL — private IPs
 * are allowed (the dogfood reaches Lobu's own private PG). Untrusted multi-tenant
 * cloud exposure is gated separately (the bundled connector is hidden under
 * LOBU_CLOUD_MODE until egress hardening lands); this runtime does not SSRF-block
 * private hosts the way the HTTP scrapers do.
 */

import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';
import { Parser } from 'node-sql-parser';
import postgres from 'postgres';

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
        'A read-only base SELECT. Do NOT add a WHERE on the cursor, an ORDER BY, or a LIMIT — the connector adds keyset pagination automatically. Alias mixed-case columns to simple names.',
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

/** Postgres type OID → a cast name we can re-apply to a string-bound checkpoint value. */
const OID_CAST: Record<number, string> = {
  1184: 'timestamptz',
  1114: 'timestamp',
  1082: 'date',
  1083: 'time',
  20: 'int8',
  23: 'int4',
  21: 'int2',
  1700: 'numeric',
  700: 'float4',
  701: 'float8',
  25: 'text',
  1043: 'varchar',
  1042: 'bpchar',
  2950: 'uuid',
  16: 'bool',
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

/**
 * Validate the user's base query and return it stripped of a trailing semicolon.
 * Rejects multi-statement, non-SELECT, top-level LIMIT/OFFSET, and positional/
 * named params — the hazards that break the keyset wrap (pi).
 */
function validateBaseQuery(raw: string): string {
  const stripped = raw.trim().replace(/;\s*$/, '');
  if (!stripped) throw new Error('query is empty');
  if (stripped.includes(';')) {
    throw new Error('query must be a single statement (no embedded ";").');
  }
  if (/\$\d/.test(stripped) || /(^|[^:]):[A-Za-z_]/.test(stripped)) {
    throw new Error('query must not contain bind parameters ($1, :name) — the connector binds the cursor itself.');
  }

  let ast: unknown;
  try {
    ast = new Parser().astify(stripped, { database: 'postgresql' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`query is not valid SQL: ${msg}`);
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    throw new Error('query must be exactly one statement.');
  }
  const stmt = statements[0] as { type?: string; limit?: { value?: unknown[] } | null };
  if (stmt.type !== 'select') {
    throw new Error(`query must be a SELECT (got ${stmt.type ?? 'unknown'}).`);
  }
  // node-sql-parser represents an ABSENT limit as `{ value: [] }` (a truthy
  // object), not null — so only reject when an actual LIMIT/OFFSET term exists.
  if (Array.isArray(stmt.limit?.value) && stmt.limit.value.length > 0) {
    throw new Error(
      'query must not include a top-level LIMIT/OFFSET — it would cap the keyset window and stall incremental sync.',
    );
  }
  return stripped;
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

    const baseSql = validateBaseQuery(config.query);
    const cursorCol = assertIdentifier(config.cursor_column, 'cursor_column');
    const pkCol = assertIdentifier(config.primary_key, 'primary_key');
    const limit = Math.min(Math.max(config.max_rows_per_sync ?? 5000, 1), 50000);
    const timeoutMs = Math.min(Math.max(config.statement_timeout_ms ?? 30000, 1000), 600000);

    const checkpoint = (ctx.checkpoint as PgCheckpoint | null) ?? {};

    const sql = postgres(connectionString, {
      max: 2,
      idle_timeout: 5,
      connect_timeout: 15,
      prepare: false,
      // Connectors must never leak the connection string into logs.
      onnotice: () => {},
    });

    try {
      // 1. Probe column types so the string-serialized checkpoint can be re-cast.
      const probe = await sql.unsafe(`SELECT * FROM (\n${baseSql}\n) q LIMIT 0`);
      const cols = (probe as unknown as { columns?: Array<{ name: string; type: number }> }).columns ?? [];
      const colByName = new Map(cols.map((c) => [c.name, c]));
      if (cols.length > 0 && !colByName.has(cursorCol)) {
        throw new Error(`cursor_column "${cursorCol}" is not a column in the query result.`);
      }
      if (cols.length > 0 && !colByName.has(pkCol)) {
        throw new Error(`primary_key "${pkCol}" is not a column in the query result.`);
      }
      const castFor = (name: string): string => {
        const t = colByName.get(name)?.type;
        const cast = t !== undefined ? OID_CAST[t] : undefined;
        return cast ? `::${cast}` : '';
      };
      const curCast = castFor(cursorCol);
      const pkCast = castFor(pkCol);

      // 2. Build the keyset-paginated query.
      const colCur = `q."${cursorCol}"`;
      const colPk = `q."${pkCol}"`;
      const haveCursor = checkpoint.last_cursor !== undefined && checkpoint.last_pk !== undefined;

      let wrapped: string;
      let params: unknown[];
      if (haveCursor) {
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

      // 3. Run read-only with a statement timeout.
      const rows = (await sql.begin(async (tx) => {
        await tx.unsafe('SET TRANSACTION READ ONLY');
        await tx.unsafe(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
        return tx.unsafe(wrapped, params as never[]);
      })) as unknown as Array<Record<string, unknown>>;

      // 4. Map rows → events, advancing the compound checkpoint to the last row.
      const events: EventEnvelope[] = [];
      let newCheckpoint: PgCheckpoint = checkpoint;
      for (const row of rows) {
        events.push(this.rowToEvent(ctx.feedKey, row, config, cursorCol, pkCol));
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

  private rowToEvent(
    feedKey: string,
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
      origin_id: `${feedKey}:${String(row[pkCol])}`,
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
