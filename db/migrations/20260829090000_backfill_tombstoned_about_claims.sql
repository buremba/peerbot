-- The claims cutover (20260827174500) stamped `about` edges from their legacy
-- connection/channel metadata only while the owning connection was still live,
-- retired the LIVE claimless remainder, and excluded every connection-scoped
-- `about` row from its ordinary manual backfill. A row that was already
-- tombstoned when its connection went away therefore fell through all three and
-- carries no `_lobu_claims`. `applyUnmerge` can restore a tombstoned
-- relationship, so leave each restorable row with an explicit owner rather than
-- reviving a claimless edge no caller can unlink and no connector can re-assert.
--
-- Authorization-bearing rows are excluded for the same reason the cutover
-- excluded them: a manual claim would let an unmerge restore an access grant
-- that only the ACL syncs may write. Rows the cutover already stamped are
-- skipped by the `_lobu_claims` guard, which also makes this re-runnable.

-- migrate:up

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
  AND rt.slug = 'about'
  AND rt.purpose IS DISTINCT FROM 'authorization'
  AND r.deleted_at IS NOT NULL
  AND NULLIF(r.metadata->>'connection_id', '') IS NOT NULL
  AND NULLIF(r.metadata->>'channel_key', '') IS NOT NULL
  AND NOT (COALESCE(r.metadata, '{}'::jsonb) ? '_lobu_claims');

-- migrate:down

-- No-op: removing an ownership claim could let a later unmerge revive a
-- relationship that no caller or connector can manage safely.
