-- migrate:up

-- An identity's connector key identifies the integration type, not the exact
-- installed account that asserted it. Keep that durable provenance on the
-- identity claim so merge reviewers can inspect the source connection.
ALTER TABLE public.entity_identities
  ADD COLUMN IF NOT EXISTS connection_id bigint REFERENCES public.connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_entity_identities_connection_id
  ON public.entity_identities(connection_id);

-- migrate:down

DROP INDEX IF EXISTS public.idx_entity_identities_connection_id;
ALTER TABLE public.entity_identities DROP COLUMN IF EXISTS connection_id;
