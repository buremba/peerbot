-- migrate:up

-- Entity merge: fold a duplicate (loser) entity into the entity it really is
-- (winner). Events are append-only — an event stamped with the loser's id in
-- `events.entity_ids` can never be rewritten — so the loser stays as a tombstone
-- carrying a forwarding pointer, and recall resolves through it.
--
-- The identity graph (entity_identities → events.metadata) is repaired directly
-- by the merge (identities move loser→winner), so connector-attributed events
-- recall against the winner for free. This pointer exists ONLY to reach the
-- other event population: rows stamped by raw `events.entity_ids` (save_content
-- memories, feed-pinned + webhook events), which the identity graph can't cover.
--
-- Columns + FK only (metadata-only, transaction-safe). The partial BTREE indexes
-- that back the read redirect are built CONCURRENTLY in the two follow-on
-- migrations (a CONCURRENTLY build can't run inside a transaction).

-- Nullable column add is metadata-only (no table rewrite / no default backfill).
ALTER TABLE public.entities ADD COLUMN IF NOT EXISTS merged_into bigint;

-- Self-FK added NOT VALID: skips the validating full-table scan + the SHARE ROW
-- EXCLUSIVE lock on `entities` at add time. The column was just introduced, so
-- there are no pre-existing non-null values to validate — no VALIDATE pass is
-- needed and none is emitted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entities_merged_into_fkey' AND conrelid = 'public.entities'::regclass
  ) THEN
    ALTER TABLE public.entities
      ADD CONSTRAINT entities_merged_into_fkey
      FOREIGN KEY (merged_into) REFERENCES public.entities(id) NOT VALID;
  END IF;
END $$;

-- Undo marker: which loser an identity was moved FROM during a merge. Lets an
-- agent/admin reverse a merge by reading live rows (move back every identity
-- WHERE merged_from_entity_id = <loser>, clear the pointer, un-tombstone) — no
-- separate audit table. Deliberately NOT overloaded onto `source_connector`,
-- which security read paths filter on (`= 'auth:signup'`); clobbering it would
-- break requester resolution in the ACL gate.
ALTER TABLE public.entity_identities ADD COLUMN IF NOT EXISTS merged_from_entity_id bigint;

-- migrate:down

ALTER TABLE public.entity_identities DROP COLUMN IF EXISTS merged_from_entity_id;
ALTER TABLE public.entities DROP CONSTRAINT IF EXISTS entities_merged_into_fkey;
ALTER TABLE public.entities DROP COLUMN IF EXISTS merged_into;
