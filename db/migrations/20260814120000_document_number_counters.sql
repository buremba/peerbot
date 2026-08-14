-- migrate:up

-- Gapless per-series document numbering (invoice `2026-000001`, …).
--
-- This is deliberately ORDINARY TABLE STATE and not a SEQUENCE. `nextval()` is
-- non-transactional, so a rolled-back insert burns its number forever; tax
-- regimes that mandate gapless numbering (TR e-Fatura, DE GoBD, …) reject
-- exactly that. Bumping a row inside the caller's transaction means COMMIT
-- makes the bump and the document durable together, and ROLLBACK returns the
-- number to the next writer. See `packages/server/src/utils/document-numbering.ts`
-- for the advisory-lock protocol that serializes writers per counter.
--
-- Bounded config-shaped table: one row per (org, entity type, series, period),
-- so a ten-year-old org with monthly series and a handful of branches holds
-- hundreds of rows, not history. The primary key is the only access path —
-- the allocator's UPSERT targets it directly, so no secondary index is needed.
CREATE TABLE IF NOT EXISTS public.document_number_counters (
  organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  -- squawk-ignore prefer-bigint-over-int -- must match the integer PK it references (entity_types.id)
  entity_type_id integer NOT NULL REFERENCES public.entity_types(id) ON DELETE CASCADE,
  -- '' when the type declares no `x-numbering.series_field`.
  series text NOT NULL,
  -- '2026' (reset: year), '2026-08' (reset: month), '' (reset: never).
  period text NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_number_counters_pkey
    PRIMARY KEY (organization_id, entity_type_id, series, period),
  CONSTRAINT document_number_counters_last_value_positive CHECK (last_value >= 0)
);

COMMENT ON TABLE public.document_number_counters IS
  'Last issued ordinal per (organization, entity type, series, period) for gapless document numbering. Bumped INSIDE the document''s own transaction so a rollback returns the number instead of burning it — never replace with a SEQUENCE.';

COMMENT ON COLUMN public.document_number_counters.last_value IS
  'Highest ordinal handed out for this counter; the next document gets last_value + 1.';

-- migrate:down

-- squawk-ignore ban-drop-table -- table introduced by this migration
DROP TABLE IF EXISTS public.document_number_counters;
