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
