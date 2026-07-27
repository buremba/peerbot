-- migrate:up

-- Store an owned web conversation's route segment instead of reconstructing it
-- from conversation_id on every list read. Platform conversations continue to
-- route by their complete conversation_id.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS thread_id text;

-- Migrations run before the app deployment changes, so an old server can still
-- insert rows after the backfill. Fill packed web ids at the database boundary
-- during that compatibility window; opaque owned ids remain unlisted, matching
-- the old reader.
CREATE OR REPLACE FUNCTION public.conversations_fill_thread_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prefix text;
BEGIN
  IF NEW.thread_id IS NOT NULL
     OR NEW.kind <> 'owned'
     OR NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  prefix := NEW.agent_id || '_' || NEW.user_id || '_' || NEW.organization_id || '_';

  IF left(NEW.conversation_id, length(prefix)) = prefix
     AND length(NEW.conversation_id) > length(prefix) THEN
    -- Packed web id: the routable thread id is the suffix.
    NEW.thread_id := substring(NEW.conversation_id from length(prefix) + 1);
  END IF;
  -- Otherwise leave NULL: either the default id has no thread suffix or the id
  -- has a foreign shape. Both remain unlisted, matching the old reader.

  RETURN NEW;
END;
$$;

-- The embedded migrator can replay SQL before recording its ledger row.
DROP TRIGGER IF EXISTS conversations_fill_thread_id ON public.conversations;
CREATE TRIGGER conversations_fill_thread_id
  BEFORE INSERT OR UPDATE OF thread_id ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.conversations_fill_thread_id();

-- Backfill only the exact known-column prefix the old reader stripped. LIKE
-- would treat underscores in ids as wildcards and could materialize a false
-- route for a foreign-shaped conversation id.
UPDATE public.conversations
   SET thread_id = substring(
         conversation_id
         from (length(agent_id || '_' || user_id || '_' || organization_id || '_') + 1)
       )
 WHERE kind = 'owned'
   AND user_id IS NOT NULL
   AND thread_id IS NULL
   AND left(
         conversation_id,
         length(agent_id || '_' || user_id || '_' || organization_id || '_')
       ) = agent_id || '_' || user_id || '_' || organization_id || '_'
   AND length(conversation_id)
       > length(agent_id || '_' || user_id || '_' || organization_id || '_');

-- migrate:down
DROP TRIGGER IF EXISTS conversations_fill_thread_id ON public.conversations;
DROP FUNCTION IF EXISTS public.conversations_fill_thread_id();
-- squawk-ignore ban-drop-column -- rollback path for the column introduced here
ALTER TABLE public.conversations
  DROP COLUMN IF EXISTS thread_id;
