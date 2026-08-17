/**
 * Platform `$resource` entity type ensure — shared by the access-graph engine
 * and attribution auto-create so a missing type never blocks a resource write.
 */

import { ACL_RESOURCE_TYPE } from '@lobu/connector-sdk';
import type { DbClient } from '../db/client.js';

/**
 * Find-or-create the org-scoped `$resource` entity type. Idempotent; empty
 * metadata schema (graph anchor only).
 *
 * The handle is REQUIRED rather than defaulted to `getDb()`: attribution
 * auto-create calls this from inside `withEntityWriteTransaction`, where a
 * pooled query would hold the transaction's connection while waiting for a
 * second one — the pool deadlock behind #2818. Requiring it means the next call
 * site has to answer the same question instead of inheriting the pool silently.
 */
export async function ensureResourceEntityType(
  sql: DbClient,
  orgId: string
): Promise<void> {
  await sql`
    INSERT INTO entity_types (slug, name, description, icon, organization_id, created_at, updated_at)
    VALUES (
      ${ACL_RESOURCE_TYPE.slug},
      ${ACL_RESOURCE_TYPE.name},
      ${ACL_RESOURCE_TYPE.description},
      ${ACL_RESOURCE_TYPE.icon},
      ${orgId},
      current_timestamp,
      current_timestamp
    )
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
  `;
}
