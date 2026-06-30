-- migrate:up

-- Sender attribution for the durable chat transcript. `author_entity_id` links a
-- captured message to the person/$member entity that wrote it (resolved at
-- capture time from the normalized identity index — store-only, NO event, never
-- embedded), and `team_id` records the workspace the author id is scoped to
-- (Slack user ids aren't globally unique). Both are additive + nullable so the
-- column add takes no rewrite and an unattributable message (bot / no team /
-- unresolved) simply leaves them NULL.
--
-- The FK is added NOT VALID then VALIDATEd in a second step so the add never
-- holds an ACCESS EXCLUSIVE lock while it scans existing rows. ON DELETE SET NULL
-- so deleting an entity orphans (not deletes) its transcript rows — transcript is
-- high-volume operational data the entity lifecycle must never cascade into.
ALTER TABLE public.channel_messages
  ADD COLUMN IF NOT EXISTS author_entity_id bigint,
  ADD COLUMN IF NOT EXISTS team_id text;

ALTER TABLE public.channel_messages
  DROP CONSTRAINT IF EXISTS channel_messages_author_entity_fkey;

ALTER TABLE public.channel_messages
  ADD CONSTRAINT channel_messages_author_entity_fkey
  FOREIGN KEY (author_entity_id) REFERENCES public.entities(id) ON DELETE SET NULL
  NOT VALID;

ALTER TABLE public.channel_messages
  VALIDATE CONSTRAINT channel_messages_author_entity_fkey;

-- migrate:down

ALTER TABLE public.channel_messages
  DROP CONSTRAINT IF EXISTS channel_messages_author_entity_fkey;

ALTER TABLE public.channel_messages
  DROP COLUMN IF EXISTS team_id,
  DROP COLUMN IF EXISTS author_entity_id;
