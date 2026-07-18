/**
 * Platform `$resource` entity type ensure — shared by the access-graph engine
 * and attribution auto-create so a missing type never blocks a resource write.
 */

import { ACL_RESOURCE_TYPE } from '@lobu/connector-sdk';
import { getDb } from '../db/client.js';

/**
 * Find-or-create the org-scoped `$resource` entity type. Idempotent; empty
 * metadata schema (graph anchor only).
 */
export async function ensureResourceEntityType(orgId: string): Promise<void> {
  const sql = getDb();
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
