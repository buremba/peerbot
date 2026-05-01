/**
 * Postgres-backed Chat SDK `StateAdapter` implemented against the shared
 * `getDb()` postgres-js client.
 *
 * Why we own this instead of using `@chat-adapter/state-pg`:
 *   - state-pg requires a `pg.Pool` (node-postgres). Owletto otherwise speaks
 *     postgres-js everywhere, so depending on state-pg meant carrying both
 *     drivers + a second connection pool just to keep one upstream library
 *     happy.
 *   - The schema is small (5 tables, all `IF NOT EXISTS`-creatable) and the
 *     methods are plain CRUD with TTL filtering. Nothing here is upstream
 *     IP — keeping it in-tree is cheaper than the dep weight.
 *
 * Schema is identical to state-pg's so an existing deployment migrates
 * transparently: same table names, same column types, same semantics.
 *
 * Concurrency: every method works on a single statement that round-trips
 * through the pool; no in-class state. Multiple gateways on the same DB
 * coordinate via row-level locks (acquire/release) and `ON CONFLICT`.
 */

import {
  ConsoleLogger,
  type Lock,
  type Logger,
  type QueueEntry,
  type StateAdapter,
} from "chat";
import { randomUUID } from "node:crypto";
import { getDb, type DbClient } from "../../db/client";

interface OwlettoStateAdapterOptions {
  /** Key prefix scoping every row. Lets multiple state-adapter consumers in
   *  the same DB coexist (e.g. "chat-conn" for the Chat SDK adapter, "foo"
   *  for some hypothetical second consumer). Defaults to "chat-sdk" to match
   *  state-pg's default for migrations. */
  keyPrefix?: string;
  logger?: Logger;
}

class OwlettoStateAdapter implements StateAdapter {
  private readonly sql: DbClient;
  private readonly keyPrefix: string;
  private readonly logger: Logger;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(options: OwlettoStateAdapterOptions = {}) {
    this.sql = getDb();
    this.keyPrefix = options.keyPrefix ?? "chat-sdk";
    this.logger =
      options.logger ?? new ConsoleLogger("info").child("state-adapter");
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = (async () => {
        try {
          await this.sql`SELECT 1`;
          await this.ensureSchema();
          this.connected = true;
        } catch (error) {
          this.connectPromise = null;
          this.logger.error("State adapter connect failed", { error });
          throw error;
        }
      })();
    }
    await this.connectPromise;
  }

  async disconnect(): Promise<void> {
    // The pool is shared with the rest of the app; we don't own its
    // lifecycle. Just flip the flag so subsequent calls re-run schema
    // checks if `connect()` is invoked again.
    this.connected = false;
    this.connectPromise = null;
  }

  // ── Subscriptions ───────────────────────────────────────────────────────

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.sql`
      INSERT INTO chat_state_subscriptions (key_prefix, thread_id)
      VALUES (${this.keyPrefix}, ${threadId})
      ON CONFLICT DO NOTHING
    `;
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.sql`
      DELETE FROM chat_state_subscriptions
      WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
    `;
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();
    const rows = await this.sql<{ one: number }>`
      SELECT 1 AS one FROM chat_state_subscriptions
      WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  // ── Locks ───────────────────────────────────────────────────────────────

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();
    const token = `pg_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + ttlMs);
    const rows = await this.sql<{
      thread_id: string;
      token: string;
      expires_at: Date;
    }>`
      INSERT INTO chat_state_locks (key_prefix, thread_id, token, expires_at)
      VALUES (${this.keyPrefix}, ${threadId}, ${token}, ${expiresAt})
      ON CONFLICT (key_prefix, thread_id) DO UPDATE
        SET token = EXCLUDED.token,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
        WHERE chat_state_locks.expires_at <= now()
      RETURNING thread_id, token, expires_at
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      threadId: row.thread_id,
      token: row.token,
      expiresAt: row.expires_at.getTime(),
    };
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.ensureConnected();
    await this.sql`
      DELETE FROM chat_state_locks
      WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
    `;
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    await this.sql`
      DELETE FROM chat_state_locks
      WHERE key_prefix = ${this.keyPrefix}
        AND thread_id = ${lock.threadId}
        AND token = ${lock.token}
    `;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();
    const rows = await this.sql<{ thread_id: string }>`
      UPDATE chat_state_locks
      SET expires_at = now() + ${ttlMs} * interval '1 millisecond',
          updated_at = now()
      WHERE key_prefix = ${this.keyPrefix}
        AND thread_id = ${lock.threadId}
        AND token = ${lock.token}
        AND expires_at > now()
      RETURNING thread_id
    `;
    return rows.length > 0;
  }

  // ── Cache ───────────────────────────────────────────────────────────────

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();
    const rows = await this.sql<{ value: string }>`
      SELECT value FROM chat_state_cache
      WHERE key_prefix = ${this.keyPrefix} AND cache_key = ${key}
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;
    if (rows.length === 0) {
      // Opportunistic cleanup of the same key if it's expired.
      await this.sql`
        DELETE FROM chat_state_cache
        WHERE key_prefix = ${this.keyPrefix} AND cache_key = ${key}
          AND expires_at <= now()
      `;
      return null;
    }
    try {
      return JSON.parse(rows[0]!.value) as T;
    } catch {
      return rows[0]!.value as unknown as T;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.ensureConnected();
    const serialized = JSON.stringify(value);
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : null;
    await this.sql`
      INSERT INTO chat_state_cache (key_prefix, cache_key, value, expires_at)
      VALUES (${this.keyPrefix}, ${key}, ${serialized}, ${expiresAt})
      ON CONFLICT (key_prefix, cache_key) DO UPDATE
        SET value = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at,
            updated_at = now()
    `;
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number
  ): Promise<boolean> {
    this.ensureConnected();
    const serialized = JSON.stringify(value);
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs) : null;
    const rows = await this.sql<{ cache_key: string }>`
      INSERT INTO chat_state_cache (key_prefix, cache_key, value, expires_at)
      VALUES (${this.keyPrefix}, ${key}, ${serialized}, ${expiresAt})
      ON CONFLICT (key_prefix, cache_key) DO NOTHING
      RETURNING cache_key
    `;
    return rows.length > 0;
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    await this.sql`
      DELETE FROM chat_state_cache
      WHERE key_prefix = ${this.keyPrefix} AND cache_key = ${key}
    `;
  }

  // ── Lists ───────────────────────────────────────────────────────────────

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number }
  ): Promise<void> {
    this.ensureConnected();
    const serialized = JSON.stringify(value);
    const expiresAt = options?.ttlMs ? new Date(Date.now() + options.ttlMs) : null;
    await this.sql`
      INSERT INTO chat_state_lists (key_prefix, list_key, value, expires_at)
      VALUES (${this.keyPrefix}, ${key}, ${serialized}, ${expiresAt})
    `;
    if (options?.maxLength) {
      await this.sql`
        DELETE FROM chat_state_lists
        WHERE key_prefix = ${this.keyPrefix} AND list_key = ${key} AND seq IN (
          SELECT seq FROM chat_state_lists
          WHERE key_prefix = ${this.keyPrefix} AND list_key = ${key}
          ORDER BY seq ASC
          OFFSET 0
          LIMIT GREATEST(
            (SELECT count(*) FROM chat_state_lists
             WHERE key_prefix = ${this.keyPrefix} AND list_key = ${key}) - ${options.maxLength},
            0
          )
        )
      `;
    }
    if (expiresAt) {
      await this.sql`
        UPDATE chat_state_lists
        SET expires_at = ${expiresAt}
        WHERE key_prefix = ${this.keyPrefix} AND list_key = ${key}
      `;
    }
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ensureConnected();
    const rows = await this.sql<{ value: string }>`
      SELECT value FROM chat_state_lists
      WHERE key_prefix = ${this.keyPrefix} AND list_key = ${key}
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY seq ASC
    `;
    return rows.map((row) => JSON.parse(row.value) as T);
  }

  // ── Queues ──────────────────────────────────────────────────────────────

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number
  ): Promise<number> {
    this.ensureConnected();
    const serialized = JSON.stringify(entry);
    const expiresAt = new Date(entry.expiresAt);
    await this.sql`
      DELETE FROM chat_state_queues
      WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
        AND expires_at <= now()
    `;
    await this.sql`
      INSERT INTO chat_state_queues (key_prefix, thread_id, value, expires_at)
      VALUES (${this.keyPrefix}, ${threadId}, ${serialized}, ${expiresAt})
    `;
    if (maxSize > 0) {
      await this.sql`
        DELETE FROM chat_state_queues
        WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId} AND seq IN (
          SELECT seq FROM chat_state_queues
          WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
            AND expires_at > now()
          ORDER BY seq ASC
          OFFSET 0
          LIMIT GREATEST(
            (SELECT count(*) FROM chat_state_queues
             WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
               AND expires_at > now()) - ${maxSize},
            0
          )
        )
      `;
    }
    const rows = await this.sql<{ depth: string | number }>`
      SELECT count(*)::int AS depth FROM chat_state_queues
      WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
        AND expires_at > now()
    `;
    return Number(rows[0]?.depth ?? 0);
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.ensureConnected();
    await this.sql`
      DELETE FROM chat_state_queues
      WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
        AND expires_at <= now()
    `;
    const rows = await this.sql<{ value: string }>`
      DELETE FROM chat_state_queues
      WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
        AND seq = (
          SELECT seq FROM chat_state_queues
          WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
            AND expires_at > now()
          ORDER BY seq ASC
          LIMIT 1
        )
      RETURNING value
    `;
    if (rows.length === 0) return null;
    return JSON.parse(rows[0]!.value) as QueueEntry;
  }

  async queueDepth(threadId: string): Promise<number> {
    this.ensureConnected();
    const rows = await this.sql<{ depth: string | number }>`
      SELECT count(*)::int AS depth FROM chat_state_queues
      WHERE key_prefix = ${this.keyPrefix} AND thread_id = ${threadId}
        AND expires_at > now()
    `;
    return Number(rows[0]?.depth ?? 0);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async ensureSchema(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS chat_state_subscriptions (
        key_prefix text NOT NULL,
        thread_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (key_prefix, thread_id)
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS chat_state_locks (
        key_prefix text NOT NULL,
        thread_id text NOT NULL,
        token text NOT NULL,
        expires_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (key_prefix, thread_id)
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS chat_state_cache (
        key_prefix text NOT NULL,
        cache_key text NOT NULL,
        value text NOT NULL,
        expires_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (key_prefix, cache_key)
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS chat_state_locks_expires_idx
      ON chat_state_locks (expires_at)
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS chat_state_cache_expires_idx
      ON chat_state_cache (expires_at)
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS chat_state_lists (
        key_prefix text NOT NULL,
        list_key text NOT NULL,
        seq bigserial NOT NULL,
        value text NOT NULL,
        expires_at timestamptz,
        PRIMARY KEY (key_prefix, list_key, seq)
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS chat_state_lists_expires_idx
      ON chat_state_lists (expires_at)
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS chat_state_queues (
        key_prefix text NOT NULL,
        thread_id text NOT NULL,
        seq bigserial NOT NULL,
        value text NOT NULL,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (key_prefix, thread_id, seq)
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS chat_state_queues_expires_idx
      ON chat_state_queues (expires_at)
    `;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error(
        "OwlettoStateAdapter is not connected. Call connect() first."
      );
    }
  }
}

/**
 * Build the Chat SDK `StateAdapter` backed by Postgres.
 *
 * Tests that don't have a live Postgres can pass an in-memory adapter via
 * the dedicated test fixture instead of calling this function.
 */
export function createGatewayStateAdapter(): StateAdapter {
  return new OwlettoStateAdapter({ keyPrefix: "chat-conn" });
}
