-- migrate:up

-- Re-stamp historical Google Calendar events onto the shared `calendar_event`
-- kind that microsoft_outlook and the apple.calendar device connector already
-- emit. Paired with the connector change in
-- packages/connectors/src/google_calendar.ts, which flips both the emitted
-- `origin_type` and the `feeds_schema.events.eventKinds` key in one commit
-- (`event_kinds` is a closed allowlist once non-empty, so the two must move
-- together or the feed stops ingesting).
--
-- Why an UPDATE and not a connector resync. The standing preference is to
-- backfill by re-running the real write path, and google_calendar.ts keys on
-- the stable `calEvent.id`, so a resync WOULD supersede the rows it returns.
-- It just cannot return most of them:
--   * the full-sync path windows the request to [now-30d, now+365d]
--     (google_calendar.ts `timeMin`/`timeMax`), and on the affected prod org
--     only 20 of 254 rows fall inside that window — 31 are older than the
--     lookback and 203 are recurring expansions past +365d, out to 2056;
--   * the incremental path sends only `syncToken`, so it returns just events
--     that CHANGED since the last sync — approximately none of the backlog.
-- A resync therefore provably restamps <8% of the history and would leave the
-- rest split across two vocabularies. This is also not a re-derived encoding
-- being mirrored in SQL: the new value is a single constant rename, not a
-- computation the connector owns.
--
-- Both columns move because the ingest path stores the connector envelope's
-- `origin_type` into `origin_type` AND `semantic_type` (prod shows every
-- google.calendar row as ('event','event')), so post-fix rows will read
-- ('calendar_event','calendar_event') and history must match.
--
-- `events` is append-only for CONTENT — this is a vocabulary correction on
-- existing rows, not a delete and not a new version, so it edits in place
-- rather than superseding. Scoped to one connector_key and idempotent: the
-- `semantic_type = 'event'` predicate makes a re-run match zero rows.
UPDATE events
SET semantic_type = 'calendar_event',
    origin_type = CASE WHEN origin_type = 'event' THEN 'calendar_event' ELSE origin_type END
WHERE connector_key = 'google.calendar'
  AND semantic_type = 'event';

-- Bridge the live ingest allowlist across the rollout. Connector writes are
-- validated against connector_definitions.feeds_schema[feed].eventKinds (a
-- per-org DB snapshot), which only converges to the bundled code via the
-- hourly refresh-connector-definitions cron. Without this, new pods emitting
-- `calendar_event` are rejected against the stale `event`-only allowlist for
-- up to an hour — and rejection is silent loss, because the run still
-- completes and advances the Google syncToken past the dropped items. Adding
-- the key (rather than renaming it) also keeps old pods emitting `event`
-- valid mid-rollout; the refresh cron then replaces feeds_schema wholesale
-- from code, which drops the leftover `event` key. Idempotent: the target-key
-- IS NULL predicate makes a re-run match zero rows.
UPDATE connector_definitions
SET feeds_schema = jsonb_set(
      feeds_schema,
      '{events,eventKinds,calendar_event}',
      feeds_schema #> '{events,eventKinds,event}'
    )
WHERE key = 'google.calendar'
  AND feeds_schema #> '{events,eventKinds,event}' IS NOT NULL
  AND feeds_schema #> '{events,eventKinds,calendar_event}' IS NULL;

-- migrate:down

UPDATE events
SET semantic_type = 'event',
    origin_type = CASE WHEN origin_type = 'calendar_event' THEN 'event' ELSE origin_type END
WHERE connector_key = 'google.calendar'
  AND semantic_type = 'calendar_event';

-- Mirror of the up-direction allowlist bridge, and a true inverse of it. Two
-- states have to be undone because the hourly refresh cron may or may not have
-- run since the up:
--   * cron already converged feeds_schema to calendar_event-only — `event` has
--     to be restored, or rolled-back code emitting it is rejected;
--   * cron has not run yet, so both keys are present — the `calendar_event` the
--     up-direction added has to come back out, otherwise `down` leaves state the
--     migration invented behind.
-- The CASE restores `event` only when it is genuinely missing; the trailing `#-`
-- always drops `calendar_event`. Idempotent: the guard means a re-run matches
-- zero rows.
UPDATE connector_definitions
SET feeds_schema = (
      CASE
        WHEN feeds_schema #> '{events,eventKinds,event}' IS NULL
          THEN jsonb_set(
                 feeds_schema,
                 '{events,eventKinds,event}',
                 feeds_schema #> '{events,eventKinds,calendar_event}'
               )
        ELSE feeds_schema
      END
    ) #- '{events,eventKinds,calendar_event}'
WHERE key = 'google.calendar'
  AND feeds_schema #> '{events,eventKinds,calendar_event}' IS NOT NULL;
