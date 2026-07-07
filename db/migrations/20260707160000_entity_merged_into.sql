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
-- Idempotent: no-op on a DB that already has the column.
ALTER TABLE public.entities ADD COLUMN IF NOT EXISTS merged_into bigint REFERENCES public.entities(id);

-- Partial index: the redirect gathers `{winner} ∪ {losers where merged_into = winner}`
-- for the `entity_ids @>` recall branch — a single indexed lookup per query, not
-- per event. Only merged rows are indexed (the column is null for live entities).
CREATE INDEX IF NOT EXISTS idx_entities_merged_into
  ON public.entities USING btree (merged_into)
  WHERE merged_into IS NOT NULL;

-- Undo marker: which loser an identity was moved FROM during a merge. Lets an
-- agent/admin reverse a merge by reading live rows (move back every identity
-- WHERE merged_from_entity_id = <loser>, clear the pointer, un-tombstone) — no
-- separate audit table. Deliberately NOT overloaded onto `source_connector`,
-- which security read paths filter on (`= 'auth:signup'`); clobbering it would
-- break requester resolution in the ACL gate.
ALTER TABLE public.entity_identities ADD COLUMN IF NOT EXISTS merged_from_entity_id bigint;

CREATE INDEX IF NOT EXISTS idx_entity_identities_merged_from
  ON public.entity_identities USING btree (merged_from_entity_id)
  WHERE merged_from_entity_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS public.idx_entity_identities_merged_from;
ALTER TABLE public.entity_identities DROP COLUMN IF EXISTS merged_from_entity_id;
DROP INDEX IF EXISTS public.idx_entities_merged_into;
ALTER TABLE public.entities DROP COLUMN IF EXISTS merged_into;
