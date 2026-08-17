import type { DbClient } from '../db/client.js';

/**
 * Invalidate in-flight ACL syncs for an organization.
 *
 * This must share the transaction that mutates the projection. Committing the
 * bump separately could let a sync observe it without the mutation it fences.
 */
export async function bumpAclGeneration(tx: DbClient, orgId: string): Promise<void> {
  await tx`
    UPDATE organization
    SET acl_generation = acl_generation + 1
    WHERE id = ${orgId}
  `;
}

/** Fail closed every ACL projection whose entity graph changed outside a sync. */
export async function invalidateOrgAcl(tx: DbClient, orgId: string): Promise<void> {
  // Lock the generation before ACL-state rows. `markAclFresh` uses the same
  // order, so its comparison cannot read an old generation and then wait behind
  // the invalidation's state-row lock.
  await bumpAclGeneration(tx, orgId);
  await tx`
    UPDATE authz_source_acl_state
    SET freshness_state = 'stale', updated_at = clock_timestamp()
    WHERE organization_id = ${orgId}
  `;
}
