-- migrate:up transaction:false

-- Existing ordinary relationships predate ownership claims, so the cutover
-- treats them as manual. Authorization edges cannot be attributed safely from
-- their legacy rows; tombstone them so the next ACL sync recreates exact
-- connection-owned claims instead of preserving an unowned access grant.
-- This is a one-time data cutover; runtime code has no legacy path.
-- The table is currently small, so batching this update would add machinery
-- without reducing deployment risk.
-- The DO statement gives the ACL-write flag transaction-local scope while the
-- migration file itself remains transaction:false for the concurrent index.
DO $claim_backfill$
BEGIN
  PERFORM set_config('lobu.acl_write', 'on', true);
  UPDATE public.entity_relationships r
  SET deleted_at = current_timestamp,
      updated_at = current_timestamp
  FROM public.entity_relationship_types rt
  WHERE rt.id = r.relationship_type_id
    AND rt.purpose = 'authorization'
    AND r.deleted_at IS NULL;

  -- Tombstoned ordinary rows are stamped too: `applyUnmerge` restores a
  -- relationship the merge soft-deleted, and an un-tombstoned row without
  -- claims would be a live edge no caller can unlink and no connector can
  -- re-assert. Authorization rows stay unstamped so nothing can restore one
  -- as a manual grant.
  UPDATE public.entity_relationships r
  SET metadata = jsonb_set(
        COALESCE(r.metadata, '{}'::jsonb),
        ARRAY['_lobu_claims']::text[],
        '{"manual": {}}'::jsonb,
        true
      ),
      updated_at = current_timestamp
  FROM public.entity_relationship_types rt
  WHERE rt.id = r.relationship_type_id
    AND rt.purpose IS DISTINCT FROM 'authorization'
    AND NOT (COALESCE(r.metadata, '{}'::jsonb) ? '_lobu_claims');
END
$claim_backfill$;

-- Partial expression index used to find exact claims on live relationships.
-- A failed concurrent build leaves an invalid index behind; remove it so a
-- migration retry always performs a real build instead of trusting the name.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationships_live_claims;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_relationships_live_claims
  ON public.entity_relationships
  USING gin ((metadata -> '_lobu_claims'))
  WHERE deleted_at IS NULL AND metadata ? '_lobu_claims';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_entity_relationships_live_claims;
