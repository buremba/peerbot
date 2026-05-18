-- migrate:up

-- Per-question state for the chat-interaction bridge — moved out of the
-- gateway's in-process Map so a button click that lands on pod B can claim
-- a question registered on pod A. The bridge keeps a small per-pod cache for
-- the platform `SentMessage` (used to edit the original card on click) since
-- that's a non-serializable SDK handle; everything that matters for routing
-- the click back into the worker (PostedQuestion + connection context) lives
-- here.

CREATE TABLE public.pending_interactions (
  id text PRIMARY KEY,
  organization_id text REFERENCES public.organization(id) ON DELETE CASCADE,
  entry_payload jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  claimed_at timestamp with time zone
);

-- Claim path is `UPDATE … SET claimed_at = now() WHERE id = $1 AND claimed_at
-- IS NULL RETURNING entry_payload`; a partial index on the unclaimed predicate
-- keeps that lookup index-only.
CREATE INDEX idx_pending_interactions_unclaimed
  ON public.pending_interactions (id)
  WHERE claimed_at IS NULL;

-- Background sweeper drops rows older than 24h; index keeps that scan cheap.
CREATE INDEX idx_pending_interactions_created_at
  ON public.pending_interactions (created_at);

-- migrate:down

DROP INDEX IF EXISTS public.idx_pending_interactions_created_at;
DROP INDEX IF EXISTS public.idx_pending_interactions_unclaimed;
DROP TABLE IF EXISTS public.pending_interactions;
