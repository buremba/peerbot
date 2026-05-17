/**
 * Shared database helpers for admin tools.
 *
 * Provides reusable "check exists or throw" patterns used across
 * manage_watchers, manage_entity_schema, manage_classifiers, etc.
 */

import type { DbClient } from '../../../db/client';

/**
 * Valid tables for requireExists. Uses a whitelist so we can safely
 * interpolate the table name into sql.unsafe() while keeping the id parameterized.
 */
const VALID_TABLES = [
  'watchers',
  'entities',
  'connections',
  'feeds',
  'event_classifiers',
  'entity_types',
  'entity_relationship_types',
  'runs',
] as const;

type ValidTable = (typeof VALID_TABLES)[number];

/**
 * Verify a record exists in the given table (by numeric id). Throws if not found.
 *
 * @param sql - Database client (or use getDb() default)
 * @param table - Table name (must be in VALID_TABLES whitelist)
 * @param id - Record id (number or numeric string)
 * @param label - Human-readable label for error messages (e.g. "Watcher")
 */
export async function requireExists(
  sql: DbClient,
  table: ValidTable,
  id: number | string,
  label?: string
): Promise<void> {
  if (!VALID_TABLES.includes(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  const rows = await sql.unsafe(`SELECT id FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  if (rows.length === 0) {
    const displayLabel = label ?? table.replace(/_/g, ' ');
    throw new Error(`${displayLabel} ${id} not found`);
  }
}

/**
 * Tables whose `id` column is allocated via SELECT MAX(id) + 1. Whitelisted so
 * the table name can be safely interpolated into sql.unsafe().
 */
const NUMERIC_ID_TABLES = ['watchers', 'watcher_windows', 'watcher_window_events', 'watcher_versions'] as const;

export type NumericIdTable = (typeof NUMERIC_ID_TABLES)[number];

/**
 * Allocate the next numeric id for a whitelisted table (`COALESCE(MAX(id), 0) + 1`).
 *
 * Race-free across concurrent transactions via a per-table Postgres advisory
 * lock keyed on `hashtext('<table>_id_alloc')`. The lock is acquired with
 * `pg_advisory_xact_lock`, so it's released automatically when the calling
 * transaction commits or rolls back. To get serialization across the
 * subsequent INSERT, the caller MUST invoke this from within a transaction
 * (otherwise each statement is its own implicit tx and the lock releases
 * before the INSERT executes — same race as without the lock).
 *
 * Without the advisory lock, two concurrent completions on DIFFERENT rows
 * (e.g. two device workers completing two different watcher runs) can both
 * compute the same `MAX(id)+1` and one will fail on the watcher_windows PK
 * conflict. With the lock + caller-side tx, the second caller blocks until
 * the first commits (and thus sees the first INSERT in its `MAX(id)`).
 */
export async function getNextNumericId(sql: DbClient, table: NumericIdTable): Promise<number> {
  if (!NUMERIC_ID_TABLES.includes(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  // Per-table key: `hashtext` returns a stable int4 derived from the string.
  // Same table → same key → serialized allocation; different tables → distinct
  // keys → no false sharing.
  await sql.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${table}_id_alloc`]);
  const rows = await sql.unsafe<{ next_id: number }>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ${table}`
  );
  return Number(rows[0]?.next_id ?? 1);
}
