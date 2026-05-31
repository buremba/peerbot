-- migrate:up

-- Invariant backstop: a DERIVED entity type (backing_sql IS NOT NULL) is a SQL
-- view and must NEVER have stored rows in `entities`. The app guards this in the
-- known insert paths (createEntity, entity-link-upsert) for friendly errors, but
-- a BEFORE INSERT trigger makes the invariant airtight regardless of which code
-- path (or future one) does the insert. Fires only for derived types — normal
-- stored-type inserts (backing_sql NULL) pass with a single PK lookup.
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
  BEFORE INSERT ON public.entities
  FOR EACH ROW EXECUTE FUNCTION public.reject_rows_on_derived_entity_type();

-- migrate:down

DROP TRIGGER IF EXISTS trg_reject_rows_on_derived ON public.entities;
DROP FUNCTION IF EXISTS public.reject_rows_on_derived_entity_type();
