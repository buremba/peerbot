/**
 * Batch-resolve user IDs to usernames.
 *
 * Takes an array of rows with a user ID field and attaches a `_username` sibling.
 * Uses a single IN query for all distinct IDs.
 */

import { getDb, pgTextArray } from '../db/client';

export async function resolveUsernames<T extends Record<string, unknown>>(
  rows: T[],
  field: string
): Promise<(T & Record<string, unknown>)[]> {
  const usernameField = `${field}_username`;
  const ids = [
    ...new Set(rows.map((r) => r[field]).filter((v): v is string => typeof v === 'string')),
  ];

  if (ids.length === 0) {
    return rows.map((r) => ({ ...r, [usernameField]: null }));
  }

  const sql = getDb();
  const userRows = await sql`
    SELECT id, username FROM "user" WHERE id = ANY(${pgTextArray(ids)}::text[])
  `;
  const lookup = new Map(userRows.map((u: any) => [u.id as string, u.username as string]));

  return rows.map((r) => ({
    ...r,
    [usernameField]: typeof r[field] === 'string' ? (lookup.get(r[field] as string) ?? null) : null,
  }));
}
