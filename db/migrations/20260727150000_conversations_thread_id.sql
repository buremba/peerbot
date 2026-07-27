-- migrate:up

-- Store the ROUTABLE id explicitly instead of re-deriving it by parsing
-- `conversation_id` at read time.
--
-- The listing loop (agent-thread-list.ts) emitted two different `id` values:
--   kind='owned'    -> the SUFFIX of the packed web id, recovered by
--                      webThreadIdFromConversationId() stripping the
--                      `{agentId}_{userId}_{orgId}_` prefix
--   kind='platform' -> the whole conversation_id
-- The frontend routes on that `id` (a web thread by threadId, a platform
-- conversation by conversationId), so the parse was reconstructing a field that
-- was simply never stored.
--
-- Parsing the id string is the same defect the `platform` column already fixed:
-- that column exists precisely because deriving the label from the id mislabelled
-- opaque ids (gchat `spaces_A_threads_B`) as web. This does the same for the
-- routable id — and it is what unblocks any NEW conversation origin (MCP
-- sessions, behaviour runs) whose id does not happen to match the web packing.
-- Under the old parse such a row was written correctly, passed every ACL check,
-- and was then SILENTLY SKIPPED at render (`if (!threadId) continue`).
--
-- NULL means "this conversation is routed by its conversation_id" — the
-- platform-branch behaviour — so the read collapses to
-- `thread_id ?? conversation_id` with no branch on kind and no skip-on-parse.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS thread_id text;

-- Backfill reproduces the OLD parse EXACTLY so no existing row changes its
-- routable id: only kind='owned' ids carrying the full
-- `{agent_id}_{user_id}_{organization_id}_` prefix yielded a thread id, and only
-- when the remaining suffix was non-empty. Rows that the parse rejected
-- (prefix-only "default thread" ids, foreign-shaped ids) keep thread_id NULL —
-- they were never listed before, and `thread_id ?? conversation_id` must not
-- resurrect them under a different route. The listing keeps skipping them via the
-- same isSafeThreadId/default-thread guards, now applied to a stored value.
UPDATE public.conversations
   SET thread_id = substring(
         conversation_id
         from (length(agent_id || '_' || user_id || '_' || organization_id || '_') + 1)
       )
 WHERE kind = 'owned'
   AND user_id IS NOT NULL
   AND conversation_id LIKE agent_id || '_' || user_id || '_' || organization_id || '_%'
   AND length(conversation_id)
       > length(agent_id || '_' || user_id || '_' || organization_id || '_');

-- migrate:down
-- squawk-ignore ban-drop-column -- rollback path for the column introduced here
ALTER TABLE public.conversations
  DROP COLUMN IF EXISTS thread_id;
