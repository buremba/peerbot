-- migrate:up

-- Drop the two dead event-recall indexes: `wa_jid` and `google_contact_id`.
--
-- Both namespaces have NO live producer anywhere in the codebase — no connector
-- emits them, no auth path writes them, no attribution rule references them.
-- They existed only as registry entries + these partial indexes (+ tests). The
-- connector-owned-identity refactor removes both namespaces from the registry,
-- so their `idx_events_metadata_<ns>` indexes are now orphans: they index a
-- column no recall branch queries. The recall-index invariant
-- (server/src/identity/recall-index-invariant.ts) fails on an orphan index, so
-- these must go with the namespace removal.
--
-- Safe: dropping a partial BTREE index cannot lose data (events rows are
-- untouched). If a WhatsApp or Google-contacts connector later needs recall on
-- these namespaces, it declares `recallNamespaces` in its identity module and
-- ships a fresh index migration — the invariant enforces the pairing.

DROP INDEX IF EXISTS idx_events_metadata_wa_jid;
DROP INDEX IF EXISTS idx_events_metadata_google_contact_id;

-- migrate:down

-- Recreate the indexes exactly as the baseline defined them (partial BTREE on
-- the extracted metadata value, only where the key is present).
CREATE INDEX IF NOT EXISTS idx_events_metadata_wa_jid
  ON events ((metadata ->> 'wa_jid'))
  WHERE metadata ? 'wa_jid';

CREATE INDEX IF NOT EXISTS idx_events_metadata_google_contact_id
  ON events ((metadata ->> 'google_contact_id'))
  WHERE metadata ? 'google_contact_id';
