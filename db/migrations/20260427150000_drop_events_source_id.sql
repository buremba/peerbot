-- migrate:up transaction:false

-- `events.source_id` is legacy and duplicates `events.connection_id`. New code
-- no longer writes or reads it, and scoring now partitions by connection_id.
-- This migration intentionally runs after that code is deployed.
SET lock_timeout = '5s';

DROP VIEW IF EXISTS public.event_thread_tree;
DROP VIEW IF EXISTS public.current_event_records;

DROP INDEX IF EXISTS public.idx_event_length;
DROP INDEX IF EXISTS public.idx_event_source_id;

ALTER TABLE public.events
    DROP COLUMN IF EXISTS source_id;

DROP TRIGGER IF EXISTS normalize_event_created_by ON public.events;
DROP FUNCTION IF EXISTS public.normalize_event_created_by();

CREATE VIEW public.current_event_records AS
 SELECT e.id,
    e.organization_id,
    e.entity_ids,
    e.origin_id,
    e.title,
    e.payload_type,
    e.payload_text,
    e.payload_data,
    e.payload_template,
    e.attachments,
    e.metadata,
    e.score,
    emb.embedding,
    e.author_name,
    e.source_url,
    e.occurred_at,
    e.created_at,
    e.origin_parent_id,
    COALESCE(length(e.payload_text), 0) AS content_length,
    e.origin_type,
    e.connector_key,
    e.connection_id,
    e.feed_key,
    e.feed_id,
    e.run_id,
    e.semantic_type,
    e.client_id,
    e.created_by,
    e.interaction_type,
    e.interaction_status,
    e.interaction_input_schema,
    e.interaction_input,
    e.interaction_output,
    e.interaction_error,
    e.supersedes_event_id
   FROM (public.events e
     LEFT JOIN public.event_embeddings emb ON ((emb.event_id = e.id)))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.events newer
          WHERE (newer.supersedes_event_id = e.id))));

CREATE VIEW public.event_thread_tree AS
 SELECT e.id,
    e.origin_id,
    e.origin_parent_id,
    e.occurred_at,
    COALESCE(parent.origin_id, e.origin_id) AS root_origin_id,
    COALESCE(parent.occurred_at, e.occurred_at) AS root_occurred_at,
    COALESCE(parent.score, e.score) AS root_score,
        CASE
            WHEN (e.origin_parent_id IS NULL) THEN 0
            ELSE 1
        END AS depth,
    ARRAY[(COALESCE(parent.occurred_at, e.occurred_at))::text, (e.id)::text] AS sort_path
   FROM (public.current_event_records e
     LEFT JOIN public.current_event_records parent ON (((e.origin_parent_id = parent.origin_id) AND (e.entity_ids && parent.entity_ids))));

-- migrate:down transaction:false

SET lock_timeout = '5s';

DROP VIEW IF EXISTS public.event_thread_tree;
DROP VIEW IF EXISTS public.current_event_records;

ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS source_id integer;

UPDATE public.events
   SET source_id = connection_id::integer
 WHERE source_id IS NULL
   AND connection_id IS NOT NULL
   AND connection_id <= 2147483647;

CREATE INDEX IF NOT EXISTS idx_event_length
    ON public.events (source_id, (COALESCE(length(payload_text), 0)));

CREATE INDEX IF NOT EXISTS idx_event_source_id
    ON public.events (source_id);

CREATE OR REPLACE FUNCTION public.normalize_event_created_by()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.created_by IN ('system', 'api') AND NOT EXISTS (
        SELECT 1 FROM public."user" u WHERE u.id = NEW.created_by
    ) THEN
        NEW.created_by := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_event_created_by ON public.events;
CREATE TRIGGER normalize_event_created_by
    BEFORE INSERT OR UPDATE OF created_by ON public.events
    FOR EACH ROW
    EXECUTE FUNCTION public.normalize_event_created_by();

CREATE VIEW public.current_event_records AS
 SELECT e.id,
    e.organization_id,
    e.entity_ids,
    e.source_id,
    e.origin_id,
    e.title,
    e.payload_type,
    e.payload_text,
    e.payload_data,
    e.payload_template,
    e.attachments,
    e.metadata,
    e.score,
    emb.embedding,
    e.author_name,
    e.source_url,
    e.occurred_at,
    e.created_at,
    e.origin_parent_id,
    COALESCE(length(e.payload_text), 0) AS content_length,
    e.origin_type,
    e.connector_key,
    e.connection_id,
    e.feed_key,
    e.feed_id,
    e.run_id,
    e.semantic_type,
    e.client_id,
    e.created_by,
    e.interaction_type,
    e.interaction_status,
    e.interaction_input_schema,
    e.interaction_input,
    e.interaction_output,
    e.interaction_error,
    e.supersedes_event_id
   FROM (public.events e
     LEFT JOIN public.event_embeddings emb ON ((emb.event_id = e.id)))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.events newer
          WHERE (newer.supersedes_event_id = e.id))));

CREATE VIEW public.event_thread_tree AS
 SELECT e.id,
    e.origin_id,
    e.origin_parent_id,
    e.occurred_at,
    COALESCE(parent.origin_id, e.origin_id) AS root_origin_id,
    COALESCE(parent.occurred_at, e.occurred_at) AS root_occurred_at,
    COALESCE(parent.score, e.score) AS root_score,
        CASE
            WHEN (e.origin_parent_id IS NULL) THEN 0
            ELSE 1
        END AS depth,
    ARRAY[(COALESCE(parent.occurred_at, e.occurred_at))::text, (e.id)::text] AS sort_path
   FROM (public.current_event_records e
     LEFT JOIN public.current_event_records parent ON (((e.origin_parent_id = parent.origin_id) AND (e.entity_ids && parent.entity_ids))));
