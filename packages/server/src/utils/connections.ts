/**
 * Connection slug helpers.
 *
 * Connections carry a stable `slug` (unique per org among live rows) so that
 * `lobu apply` can diff connections by an immutable key instead of the mutable
 * `display_name`. The slugify rules here MUST stay in sync with the backfill in
 * db/migrations/20260512131703_connections_slug.sql.
 */

import type postgres from 'postgres';
import { getDb } from '../db/client';
import { generateSlug } from './entity-management';

// Accepts either the singleton pool or a transaction handle from `sql.begin`.
type Sql = postgres.Sql<Record<string, never>> | postgres.TransactionSql<Record<string, never>>;

/**
 * Slugify a connection name: lowercase, runs of non-alphanumerics → `-`,
 * trim leading/trailing `-`. Returns an empty string when the input has no
 * alphanumeric characters (callers fall back to a connector-key-derived slug).
 */
export function slugifyConnectionName(value: string | null | undefined): string {
  if (!value) return '';
  return generateSlug(value);
}

/**
 * Resolve a unique connection slug for an org.
 *
 * - Prefer an explicit slug, then the slugified display name, then
 *   `connectorKey` as the base.
 * - If the base is taken by another live (`deleted_at IS NULL`) connection in
 *   the org, append `-2`, `-3`, … until free.
 * - `excludeId` skips a specific connection row (used on update so a connection
 *   doesn't collide with itself).
 * - Pass `sql` to run inside an existing transaction (e.g. worker autowire).
 */
export async function ensureUniqueConnectionSlug(params: {
  organizationId: string;
  connectorKey: string;
  explicitSlug?: string | null;
  displayName?: string | null;
  excludeId?: number | null;
  sql?: Sql;
}): Promise<string> {
  const sql = params.sql ?? getDb();
  const fromExplicit = slugifyConnectionName(params.explicitSlug);
  const fromName = slugifyConnectionName(params.displayName);
  const baseSlug = fromExplicit || fromName || slugifyConnectionName(params.connectorKey) || 'connection';

  let candidate = baseSlug;
  let suffix = 2;
  for (;;) {
    const rows = await sql`
      SELECT id
      FROM connections
      WHERE organization_id = ${params.organizationId}
        AND slug = ${candidate}
        AND deleted_at IS NULL
        AND (${params.excludeId ?? null}::bigint IS NULL OR id <> ${params.excludeId ?? null}::bigint)
      LIMIT 1
    `;
    if (rows.length === 0) return candidate;
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
}
