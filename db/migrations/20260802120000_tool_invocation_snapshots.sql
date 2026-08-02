-- migrate:up

-- Encrypted request arguments for tool-invocation audit rows.
--
-- Deliberately NOT a jsonb field on `events`. Three reasons, all structural:
--
--  1. `events.payload_data` is read by every generic content path — get_content,
--     content-search, the query_sql CTE, resolve_path's bootstrap. Putting a
--     multi-megabyte ciphertext there means every one of those paths needs its
--     own strip, and the next read path added silently leaks it. A separate
--     relation is unreachable by construction: there is nothing to strip.
--  2. `events` is append-only, so a body parked in it can never be aged out.
--     Snapshot retention is a DELETE here, which touches no event row.
--  3. `events` is already ~12GB with the audit rows alone at 27% of the table.
--     Keeping the audit row itself ~250 bytes preserves every existing query
--     plan and keeps the bulk payload out of TOAST on the hot table.
--
-- `event_embeddings` is the existing precedent for exactly this shape: bulky
-- per-event artifact, keyed by event_id, FK-cascaded, never joined by default.
--
-- Tenancy is the FK: every read resolves the owning `events` row first (which
-- is org-scoped and creator/admin-gated) and only then loads the body by id,
-- so an organization_id column here would be a second copy of a fact the join
-- already establishes.
CREATE TABLE IF NOT EXISTS public.tool_invocation_snapshots (
  event_id bigint PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  -- AES-256-GCM encrypted JSON; decrypted only by the creator/admin endpoint.
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Retention sweep predicate: delete oldest-first past the TTL.
-- squawk-ignore require-concurrent-index-creation -- table created immediately above; no existing rows or traffic
CREATE INDEX IF NOT EXISTS tool_invocation_snapshots_created_at
  ON public.tool_invocation_snapshots (created_at);

-- migrate:down

-- squawk-ignore ban-drop-table -- created by this migration; bodies are a derived, expiring artifact
DROP TABLE IF EXISTS public.tool_invocation_snapshots;
