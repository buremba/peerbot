-- migrate:up

-- Invariant backstop: a DERIVED entity type (backing_sql IS NOT NULL) is a SQL
-- view and must NEVER have stored rows in `entities`. The app guards this in the
-- known paths (createEntity, entity-link-upsert, manage_entity_schema convert)
-- for friendly errors, but these triggers make the invariant airtight regardless
-- of which code path (or future one) writes the data.

-- (1) No stored row may point at a derived type — on INSERT, and on an UPDATE
-- that re-points an existing row's entity_type_id. Fires only when the target
-- type is derived; normal stored-type writes pass with a single PK lookup.
CREATE OR REPLACE FUNCTION public.reject_rows_on_derived_entity_type()
  RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.entity_types et
    WHERE et.id = NEW.entity_type_id AND et.backing_sql IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'entity type % is derived (a SQL view) and cannot have stored rows',
      NEW.entity_type_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_rows_on_derived ON public.entities;
CREATE TRIGGER trg_reject_rows_on_derived
  BEFORE INSERT OR UPDATE OF entity_type_id ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.reject_rows_on_derived_entity_type();

-- (2) A type may not BECOME derived while stored rows still exist — that would
-- orphan them (the view ignores stored rows). Fires only when backing_sql is set
-- in the UPDATE; clearing it (derived → stored) is always allowed.
CREATE OR REPLACE FUNCTION public.reject_derived_conversion_with_rows()
  RETURNS trigger AS $$
BEGIN
  IF NEW.backing_sql IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.entities e
    WHERE e.entity_type_id = NEW.id AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'entity type % cannot become a derived view while stored rows exist; delete them first',
      NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_derived_conversion_with_rows ON public.entity_types;
CREATE TRIGGER trg_reject_derived_conversion_with_rows
  BEFORE UPDATE OF backing_sql ON public.entity_types
  FOR EACH ROW EXECUTE FUNCTION public.reject_derived_conversion_with_rows();

-- migrate:down

DROP TRIGGER IF EXISTS trg_reject_derived_conversion_with_rows ON public.entity_types;
DROP FUNCTION IF EXISTS public.reject_derived_conversion_with_rows();
DROP TRIGGER IF EXISTS trg_reject_rows_on_derived ON public.entities;
DROP FUNCTION IF EXISTS public.reject_rows_on_derived_entity_type();
