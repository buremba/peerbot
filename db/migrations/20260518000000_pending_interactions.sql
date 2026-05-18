-- migrate:up

-- Per-question state for the chat-interaction bridge — moved out of the
-- gateway's in-process Map so a button click that lands on pod B can claim
-- a question registered on pod A. The bridge keeps a small per-pod cache for
-- the platform `SentMessage` (used to edit the original card on click) since
-- that's a non-serializable SDK handle; everything that matters for routing
-- the click back into the worker (PostedQuestion + connection context) lives
-- here.
--
-- The claim path scopes by `(id, organization_id, connection_id,
-- expected_user_id)` — keying by `id` alone would let a click from one
-- connection or one user consume a question registered for another. The
-- columns are NOT NULL so the SQL claim is a single index hit with no
-- branching for NULL semantics.

CREATE TABLE public.pending_interactions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  connection_id text NOT NULL,
  expected_user_id text NOT NULL,
  entry_payload jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  claimed_at timestamp with time zone
);

-- Claim path is
--   UPDATE pending_interactions
--      SET claimed_at = now()
--    WHERE id = $1
--      AND organization_id = $2
--      AND connection_id = $3
--      AND expected_user_id = $4
--      AND claimed_at IS NULL
--   RETURNING entry_payload
-- — a partial index on the unclaimed predicate keeps the lookup index-only.
CREATE INDEX idx_pending_interactions_unclaimed
  ON public.pending_interactions (id, organization_id, connection_id, expected_user_id)
  WHERE claimed_at IS NULL;

-- Background sweeper drops rows older than 24h; index keeps that scan cheap.
CREATE INDEX idx_pending_interactions_created_at
  ON public.pending_interactions (created_at);

-- migrate:down

DROP INDEX IF EXISTS public.idx_pending_interactions_created_at;
DROP INDEX IF EXISTS public.idx_pending_interactions_unclaimed;
DROP TABLE IF EXISTS public.pending_interactions;
