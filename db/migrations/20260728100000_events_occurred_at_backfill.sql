-- Backfill occurred_at on agent/system-emitted events that were inserted NULL.
--
-- insertEvent had no occurred_at default, so callers that supplied no source
-- timestamp (operation approval cards, tool-invocation audit rows, and
-- change/lifecycle/config audit trails) persisted NULL. NULL occurred_at is
-- excluded by the memory feed's since/until filters, sorts ahead of dated rows
-- under `ORDER BY occurred_at DESC`, and can prevent construction of a
-- before_occurred_at keyset cursor. The code fix stamps insert time for new
-- insertEvent rows; created_at is the best available approximation for existing
-- rows because these events had no separate source timestamp.
--
-- Metadata-only repair of rows that were never orderable; payloads untouched
-- (append-only invariant applies to content).

-- migrate:up
UPDATE public.events
   SET occurred_at = created_at
 WHERE occurred_at IS NULL;

-- migrate:down
-- Intentionally empty: the pre-backfill NULLs carried no information, and new
-- inserts default occurred_at anyway — there is no meaningful prior state to
-- restore.
