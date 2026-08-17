-- migrate:up

-- Arms the authorization-edge trigger by classifying the one slug the ACL syncs
-- own. This is the deliberate second release of the split that lobu#2825 began:
-- that release added `purpose` and the trigger without backfilling, and made
-- every ACL writer set the transaction-local `lobu.acl_write` flag first.
--
-- Keeping classification in this later release means every application version
-- that can overlap this migration already supplies the flag, so the rolling
-- deploy cannot leave an older pod writing guarded edges without it.
--
-- Classifies EVERY `member_of` row, not just the platform-created ones. A prod
-- audit on 2026-08-16 found all four existing rows to be platform-created —
-- `created_by` NULL, live edges only `source='feed'` — so no org's own
-- vocabulary is being reclassified out from under it today. `created_by` must
-- not be the filter regardless:
-- `ensureMemberOfType` upserts on (organization_id, slug), so it ADOPTS an
-- org-authored row as the ACL type, and that row keeps its non-NULL
-- `created_by`. Filtering on it would leave a live ACL type unclassified — the
-- trigger inert for exactly the org that authored its own row, which is the
-- hole `purpose` exists to close.
--
-- No status or deletion filter: the current ACL reads select `member_of` by slug
-- without a relationship-type lifecycle predicate. Any surviving edge attached
-- to an archived row is still access-bearing and must be guarded too.
--
-- The `purpose IS NULL` predicate makes re-running a no-op instead of churning
-- every row's `updated_at`.
UPDATE entity_relationship_types
SET purpose = 'authorization',
    updated_at = current_timestamp
WHERE slug = 'member_of'
  AND purpose IS NULL;

-- migrate:down

-- Declassifying makes the trigger inert again. The current read gates still
-- trust the slug during this rollout, so this widens who may write the edges
-- without narrowing who may read them. The earlier migration owns removal of
-- the `purpose` column and must be rolled back later, in reverse migration order.
UPDATE entity_relationship_types
SET purpose = NULL,
    updated_at = current_timestamp
WHERE slug = 'member_of'
  AND purpose = 'authorization';
