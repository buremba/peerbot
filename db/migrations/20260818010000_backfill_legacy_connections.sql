-- migrate:up transaction:false

-- Backfill legacy private connections (created_by IS NULL) that predate the
-- created_by column or were orphaned by a user hard-delete (the FK uses
-- ON DELETE SET NULL).
--
-- Owner/admin visibility for these rows was previously handled by a special-case
-- arm in compileConnectionRowVisibility that we are about to remove. Every
-- private connection must have a non-null created_by so the standard
-- `created_by = principal` predicate works.
--
-- Strategy: adopt each orphan into the hands of its org's first admin (by role
-- priority owner > admin > member, then oldest membership). Falls back to any
-- member; orgs with zero members keep NULL (those connections are invisible to
-- everyone anyway — the org has no principals).
--
-- Adoption seam note: setting created_by also makes the row match
-- compileConnectionFkVisibility (events/content/operations), so the adopting
-- owner gains search/recall visibility into that connection's content that NO
-- principal had before (the removed admin arm was row-form only). That widening
-- is the point of this backfill — the alternative is admin-only row visibility
-- with no corresponding operations visibility, which is the split the change
-- eliminates.
--
-- Scope: only private, non-deleted, unpinned rows. Org-visible rows already
-- match `visibility = 'org'`, and device-pinned rows are adopted to the real
-- device user by device-reconcile.ts (which guards on `created_by IS NULL`), so
-- adopting either here would steal the ownership a later pass would assign.
--
-- Runs outside dbmate's transaction sandbox. The body is a single UPDATE, which
-- is atomic on its own and idempotent on re-run (the WHERE clause only matches
-- NULL rows), so re-running after a partial application — e.g. an interruption,
-- or this migration replayed against a live DB mid-write — cannot double-adopt
-- or strand a row in a half-adopted state.

UPDATE connections c
SET created_by = sub.adopter_id,
    updated_at = NOW()
FROM (
  SELECT DISTINCT ON (m."organizationId")
    m."organizationId" AS org_id,
    m."userId" AS adopter_id
  FROM "member" m
  ORDER BY m."organizationId",
           CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
           m."createdAt" ASC
) sub
WHERE c.organization_id = sub.org_id
  AND c.created_by IS NULL
  AND c.visibility = 'private'
  AND c.deleted_at IS NULL
  AND c.device_worker_id IS NULL;

-- migrate:down

-- No-op: NULL → non-NULL backfill is safe to keep. The admin visibility arm
-- that required this backfill is being removed in the same release, so there
-- is no code path that depends on these rows being NULL again.
