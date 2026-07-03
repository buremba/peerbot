-- migrate:up

-- Crash-safety for the preceding CONCURRENTLY build: if the server died mid
-- build, the index is left INVALID and the previous file's IF NOT EXISTS would
-- skip it forever — while the new code's ON CONFLICT arbiter inference (42P10)
-- rejects invalid indexes. Drop the carcass here so the next file can rebuild.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'agent_channel_bindings_connection_channel_unique'
      AND NOT i.indisvalid
  ) THEN
    EXECUTE 'DROP INDEX public.agent_channel_bindings_connection_channel_unique';
  END IF;
END
$$;

-- migrate:down

-- No-op: the heal step has nothing to undo.
SELECT 1;
