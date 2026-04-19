/**
 * PostgreSQL Database Client
 *
 * Provides a singleton postgres.js pool via getDb(), plus factory functions
 * for creating additional connections when needed.
 */

import postgres from 'postgres';
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

function createDbClient(connectionString: string, maxConnections?: number): DbClient {
  const embeddedCompatMode = process.env.OWLETTO_DISABLE_PREPARE === '1';
  const embeddedProtocolOptions = embeddedCompatMode
    ? ({ max_pipeline: 1, prepare: false } as Record<string, unknown>)
    : {};

  const rawClient = postgres(connectionString, {
    max: maxConnections ?? parseInt(process.env.DB_POOL_MAX || '10', 10),
    idle_timeout: 20,
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
  }) as unknown as DbClient;

  if (!embeddedCompatMode) {
    return rawClient;
  }

  return createSerializedClient(rawClient);
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

/**
 * Get the singleton PostgreSQL client.
 * Lazily created from DATABASE_URL on first call.
 */
export function getDb(): DbClient {
  if (!dbSingleton) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is required');
    }
    dbSingleton = createDbClient(url);
    logger.info('[DB] PostgreSQL singleton pool created');
  }
  return dbSingleton;
}

/**
 * Close and reset the singleton PostgreSQL client.
 * Primarily used by tests that need strict connection handoff between setup and workers.
 */
export async function closeDbSingleton(): Promise<void> {
  if (dbSingleton?.end) {
    await dbSingleton.end();
  }
  dbSingleton = null;
}
