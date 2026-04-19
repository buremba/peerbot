-- migrate:up

-- Speeds up the event↔entity join declared by the WhatsApp connector's
-- early entityLinks rule: events JOIN entities ON
--   entities.metadata->>'wa_jid' = events.metadata->>'chat_jid'.
-- Superseded by the entity_identities table (2026-04-17 migration) which
-- drops this index; this file is kept so dbmate's history is preserved.
CREATE INDEX IF NOT EXISTS idx_entities_wa_jid
  ON public.entities (entity_type, (metadata->>'wa_jid'))
  WHERE metadata ? 'wa_jid' AND deleted_at IS NULL;

-- migrate:down

DROP INDEX IF EXISTS public.idx_entities_wa_jid;
