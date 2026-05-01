/**
 * PostgreSQL Database Client
 *
 * Provides a singleton postgres.js pool via getDb(), plus factory functions
 * for creating additional connections when needed.
 */

import { PostgresJSDialect } from 'kysely-postgres-js';
import postgres, { type Sql } from 'postgres';
import type { Env } from '../index';
import logger from '../utils/logger';

/**
 * SQL client interface — a postgres.js tagged-template client.
 */
export interface DbQuery<T = any> extends Promise<T[] & { count: number }> {
  simple?: () => DbQuery<T>;
}

export interface DbClient {
  <T = any>(strings: TemplateStringsArray, ...values: unknown[]): DbQuery<T>;
  unsafe<T = any>(query: string, params?: unknown[], queryOptions?: unknown): DbQuery<T>;
  array<T extends string | number>(values: T[], type?: string): unknown;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: DbClient) => Promise<T>): Promise<T>;
  end?: () => Promise<void>;
}

export function simpleQuery<T>(query: DbQuery<T>): DbQuery<T> {
  return query;
}

/**
 * Format a JS string array as a PostgreSQL array literal.
 *
 * postgres.js with `fetch_types: false` can't auto-serialize JS arrays
 * into PostgreSQL array values. This helper produces a literal like
 * `{"value1","value2"}` that can be used with a `::text[]` cast.
 */
export function pgTextArray(values: (string | null)[]): string {
  const escaped = values.map((v) =>
    v === null ? 'NULL' : '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  );
  return '{' + escaped.join(',') + '}';
}

/**
 * Format a JS number array as a PostgreSQL bigint[] literal.
 */
export function pgBigintArray(values: number[]): string {
  const normalized = values.map((value) => String(Math.trunc(value)));
  return '{' + normalized.join(',') + '}';
}

// PostgreSQL type OIDs
const PG_OID_JSON = 114;
const PG_OID_JSONB = 3802;

// =========================================================
// PostgreSQL client factory
// =========================================================

interface CreatedDbClient {
  /** Client used by application code; in pglite mode this is queue-serialized. */
  wrapped: DbClient;
  /** Raw postgres.js Sql client. Bypasses the serialization queue — only safe
   *  for callers that own their own connection (e.g. Kysely via reserve()). */
  raw: Sql;
}

function createDbClient(connectionString: string, maxConnections?: number): CreatedDbClient {
  const embeddedCompatMode = process.env.OWLETTO_DISABLE_PREPARE === '1';
  const embeddedProtocolOptions = embeddedCompatMode
    ? ({ max_pipeline: 1, prepare: false } as Record<string, unknown>)
    : {};

  const rawClient = postgres(connectionString, {
    max: maxConnections ?? parseInt(process.env.DB_POOL_MAX || '20', 10),
    // Keep connections forever client-side. Postgres handles eviction via its
    // own idle/lifetime settings; recycling every 20s on the client side
    // forces every spotty-traffic burst to pay a ~1s TCP+TLS handshake.
    idle_timeout: 0,
    // Cap connection lifetime so long-lived sockets survive a finite duration
    // (defends against PG-side state drift, certificate rotations, etc.).
    max_lifetime: 60 * 30,
    connection: {
      application_name: 'server',
    },
    fetch_types: false,
    ...embeddedProtocolOptions,
    transform: {
      value: {
        // IMPORTANT: fetch_types: false means postgres.js doesn't auto-parse
        // JSON/JSONB columns. This transform runs on every value in every row
        // (both tagged-template and sql.unsafe() queries) and parses any
        // JSON/JSONB column based on its PostgreSQL OID. This is the single
        // source of truth for JSONB parsing — no per-field workarounds needed.
        from: (value: unknown, column: { type: number }) => {
          if (
            (column.type === PG_OID_JSON || column.type === PG_OID_JSONB) &&
            typeof value === 'string'
          ) {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          }
          return value;
        },
      },
    },
    types: {
      bigint: {
        to: 20,
        from: [20],
        parse: (value: string) => {
          const num = Number(value);
          if (process.env.NODE_ENV === 'development' && !Number.isSafeInteger(num)) {
            logger.warn({ value, parsed: num }, 'BIGINT value exceeds safe integer range');
          }
          return num;
        },
        serialize: (value: number) => String(value),
      },
    },
  });

  const dbClient = rawClient as unknown as DbClient;

  if (!embeddedCompatMode) {
    return { wrapped: dbClient, raw: rawClient };
  }

  return { wrapped: createSerializedClient(dbClient), raw: rawClient };
}

function createSerializedClient(client: DbClient): DbClient {
  let queue: Promise<void> = Promise.resolve();

  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run, run);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  const wrapped = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    serialize(() => client(strings, ...values))) as DbClient;

  wrapped.unsafe = (query, params, queryOptions) =>
    serialize(() => client.unsafe(query, params, queryOptions)) as DbQuery<any>;
  wrapped.array = client.array.bind(client);
  wrapped.json = client.json.bind(client);
  wrapped.begin = async <T>(fn: (sql: DbClient) => Promise<T>) =>
    client.begin((tx) => fn(createSerializedClient(tx)));
  if (client.end) {
    wrapped.end = client.end.bind(client);
  }

  return wrapped;
}

/**
 * Create a database client from environment.
 * Reuses the singleton pool — kept for call-site compatibility.
 */
export function createDbClientFromEnv(_env: Env): DbClient {
  return getDb();
}

// =========================================================
// Singleton pool
// =========================================================

let dbSingleton: DbClient | null = null;
let rawDbSingleton: Sql | null = null;

function ensureSingleton(): void {
  if (dbSingleton) return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  const created = createDbClient(url);
  dbSingleton = created.wrapped;
  rawDbSingleton = created.raw;
  logger.info('[DB] PostgreSQL singleton pool created');
}

/**
 * Get the singleton PostgreSQL client.
 * Lazily created from DATABASE_URL on first call.
 */
export function getDb(): DbClient {
  ensureSingleton();
  return dbSingleton as DbClient;
}

/**
 * Close and reset the singleton PostgreSQL client.
 * Primarily used by tests that need strict connection handoff between setup and workers.
 */
export async function closeDbSingleton(): Promise<void> {
  if (rawDbSingleton?.end) {
    await rawDbSingleton.end();
  } else if (dbSingleton?.end) {
    await dbSingleton.end();
  }
  dbSingleton = null;
  rawDbSingleton = null;
}

/**
 * Kysely dialect bound to the singleton postgres.js client. Used by better-auth
 * so that auth queries share the same connection pool as the rest of the app
 * instead of opening a second pg.Pool with its own (cold-prone) connections.
 *
 * Uses the raw (un-wrapped) postgres.js client because PostgresJSDialect calls
 * sql.reserve() to acquire a dedicated connection — a code path the in-process
 * pglite serialization wrapper doesn't proxy. This matches the pre-refactor
 * behavior where better-auth ran on its own pg.Pool entirely outside the
 * wrapper, so pglite tests that exercise auth retain their existing semantics.
 */
export function getAuthDialect(): PostgresJSDialect {
  ensureSingleton();
  if (!rawDbSingleton) {
    throw new Error('rawDbSingleton was not initialized');
  }
  return new PostgresJSDialect({ postgres: rawDbSingleton });
}

/**
 * Raw postgres.js Sql client. Exposes the full postgres-js surface (most
 * notably `listen()` / `notify()`) which the `DbClient` wrapper does not.
 *
 * postgres-js's `sql.listen(channel, fn)` lazily constructs ONE dedicated
 * listener connection (max:1, idle_timeout:null) and multiplexes every
 * subscriber across the whole gateway onto that single connection. So all
 * caches + the runs queue all share one LISTEN socket via this entry point.
 */
export function getRawDb(): Sql {
  ensureSingleton();
  if (!rawDbSingleton) {
    throw new Error('rawDbSingleton was not initialized');
  }
  return rawDbSingleton;
}

/**
 * Typed view of postgres-js's `sql.listen()` surface. Use this instead of
 * `getRawDb()` when you only need LISTEN/NOTIFY — keeps the broader Sql
 * type out of caller signatures and centralises the cast that postgres-js's
 * own typings sometimes need.
 *
 * `onListen` fires once on initial subscribe and again on every reconnect
 * (postgres-js's internal `onclose` re-issues LISTEN automatically); use
 * it to drop any cached state that may have crossed a missed-NOTIFY gap.
 */
export interface DbListener {
  listen(
    channel: string,
    onNotify: (payload: unknown) => void,
    onListen?: () => void
  ): Promise<{ unlisten: () => Promise<unknown> }>;
}

export function getDbListener(): DbListener {
  return getRawDb() as unknown as DbListener;
}

/**
 * Verify that LISTEN/NOTIFY round-trips through the configured DATABASE_URL.
 *
 * Why this exists: pgbouncer in transaction-mode silently drops `LISTEN` (the
 * subscription is bound to the backend, but transaction-mode pooling returns
 * a different backend on the next checkout). RDS Proxy and other transaction-
 * mode poolers behave the same. `RunsQueue` depends on LISTEN being delivered
 * for sub-200ms dispatch wakeup; without the probe, a misconfiguration surfaces
 * as 200ms-poll queue latency with no error.
 *
 * Resolves with `void` on success. Rejects with a clear message after the
 * `timeoutMs` window if no notification arrives — the caller (server boot)
 * is expected to fail-fast.
 */
export async function probeListenNotify(timeoutMs = 1500): Promise<void> {
  const sql = getRawDb();
  const listener = getDbListener();
  const channel = `lobu_probe_${process.pid}_${Date.now().toString(36)}`;

  let received = false;
  let resolveReceived: (() => void) | null = null;
  const receivedPromise = new Promise<void>((res) => {
    resolveReceived = res;
  });

  const result = await listener.listen(channel, () => {
    received = true;
    resolveReceived?.();
  });

  try {
    await sql`SELECT pg_notify(${channel}, 'probe')`;

    const timeout = new Promise<void>((_, reject) => {
      const t = setTimeout(() => {
        if (received) return;
        reject(
          new Error(
            `LISTEN/NOTIFY probe timed out after ${timeoutMs}ms — DATABASE_URL ` +
              'appears to point at a transaction-mode connection pooler ' +
              '(pgbouncer transaction-mode, RDS Proxy, etc.) which silently ' +
              'drops LISTEN. The cache invalidation and runs-queue wakeup ' +
              'paths require a session-mode pool. Set DATABASE_URL to a ' +
              'session-mode endpoint (or session-mode pooler) and retry.'
          )
        );
      }, timeoutMs);
      t.unref?.();
    });

    await Promise.race([receivedPromise, timeout]);
  } finally {
    try {
      await result.unlisten();
    } catch {
      // ignore
    }
  }
}
