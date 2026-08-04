/**
 * Denormalized org-scope bridge (`events.linked_org_ids`).
 *
 * Org-scoped reads (content feed, derived views, data sources) answer "is
 * this event visible to org X?" via:
 *
 *   organization_id = $org OR linked_org_ids @> ARRAY[$org]
 *
 * instead of the legacy per-row OR/EXISTS bridge (entities in `entity_ids`
 * plus the producing connection), which defeated every index on the outer
 * scan. The array folds both bridge branches into one GIN-indexed column.
 *
 * The column is WRITE-ONCE: set at INSERT (and in the webhook-attribution
 * tail of the same atomic write) and never updated — events are append-only,
 * and the inputs (entity orgs, connection org) are immutable, so the
 * insert-time value stays correct forever. Known documented edge: the
 * entity-tree deletion prune removes ids from `events.entity_ids` without
 * touching this frozen column, so an event stays bridge-visible in a deleted
 * cross-org entity's org until superseded (over-visibility only).
 *
 * `{}` = no linked orgs. NULL = pre-backfill rows only.
 */

/**
 * Rollout gate for reading the denormalized bridge in org-scope predicates.
 * Flip ON only after the one-time backfill has completed for every org —
 * pre-backfill rows carry NULL and would lose bridge visibility otherwise.
 */
export function useLinkedOrgScope(): boolean {
	return process.env.LOBU_LINKED_ORG_SCOPE === "1";
}
