# Migrations

dbmate-managed SQL under `db/migrations/`. Names are `<UTC-yyyymmddHHMMSS>_<slug>.sql` with a `-- migrate:up` / `-- migrate:down` split. Pre-upgrade Helm hook runs `dbmate up` against the prod database before the app rolls.

Most migrations are routine: an additive column, a small index, a view bump. The risk lives in the ones that **rewrite a hot table** or **rebuild a large index**. Get those wrong and prod stalls under `ACCESS EXCLUSIVE` until the database's `statement_timeout` fires, after which dbmate exits non-zero, the migration leaves no row in `schema_migrations`, and the app deploys forward into a schema it expects but doesn't have. That's the 2026-05-16 outage in one sentence ([PR #767](https://github.com/lobu-ai/lobu/pull/767)).

The rules below are what we wish #765 had followed.

---

## Always

- **Read what your DDL actually does.** Postgres has three speeds: `O(1)` metadata flip, `O(rows)` table rewrite under `ACCESS EXCLUSIVE`, and `O(rows)` write with regular row locks. Know which one you wrote.
- **State the operational cost in the migration body** as a comment, in seconds for the real table size, not "should be fast." Cite the row count you tested on. If you didn't test on the real size, say so.
- **Keep migrations idempotent on the up-side** when practical (`CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`). dbmate doesn't retry, but a half-applied transaction recovered manually is easier when the SQL is re-runnable.

---

## Watch out for

### `ADD COLUMN ... GENERATED ALWAYS AS (...) STORED`

This rewrites every row to materialize the generated value. On the 1.15M-row `events` table the rewrite took >60s and tripped the DB's `statement_timeout`. Do not use `GENERATED STORED` on any table over ~100k rows during a Helm hook.

**Safe pattern:**

```sql
-- migrate:up

-- Step 1: nullable column, no backfill, no rewrite. O(1).
ALTER TABLE events ADD COLUMN IF NOT EXISTS search_tsv tsvector;

-- Step 2: trigger so new rows get the value (fast inserts; trigger overhead
-- is the cost of doing this incrementally).
CREATE OR REPLACE FUNCTION events_set_search_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.payload_text, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_set_search_tsv ON events;
CREATE TRIGGER trg_events_set_search_tsv
  BEFORE INSERT OR UPDATE OF title, payload_text ON events
  FOR EACH ROW EXECUTE FUNCTION events_set_search_tsv();
```

Then **backfill in a separate migration / script** that runs in batches outside the Helm hook (e.g. a `BATCH_BACKFILL=1`-gated boot path or a `scripts/backfill-*.sh` runbook):

```sql
UPDATE events SET search_tsv =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(payload_text, '')), 'B')
WHERE id BETWEEN $START AND $END AND search_tsv IS NULL;
```

Pace ~10k rows per batch with a sleep between batches; each batch is its own transaction so VACUUM can keep up.

### `CREATE INDEX` on a large table

Plain `CREATE INDEX` takes a `SHARE` lock on the table — reads still work, but **writes block** for the duration of the build. On `events` that's seconds of stalled INSERTs.

**Safe pattern:** `CREATE INDEX CONCURRENTLY`. Multiple passes, but only takes `SHARE UPDATE EXCLUSIVE` so reads + writes continue.

```sql
-- CONCURRENTLY does not run inside a transaction. dbmate runs each .sql
-- file in a single implicit transaction unless you opt out, so:
--
-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_search_tsv
  ON events USING gin (search_tsv);
```

If the migration *must* be one file with the column-add too, the column-add stays in a normal transaction-wrapped migration and the index is a follow-up `transaction:false` migration.

**`CONCURRENTLY` + `IF NOT EXISTS` trap:** if a previous `CREATE INDEX CONCURRENTLY` failed mid-build (timeout, deadlock, connection dropped), Postgres leaves an **invalid** index behind. The index *name* exists, so the next `CREATE INDEX CONCURRENTLY IF NOT EXISTS` skips the rebuild — and now your "successful" deploy is using a half-built index that the planner refuses to read from. Before retrying, check:

```sql
SELECT i.relname, x.indisvalid
  FROM pg_class i
  JOIN pg_index x ON x.indexrelid = i.oid
 WHERE i.relname = 'idx_events_search_tsv';
```

If `indisvalid = false`, drop it with `DROP INDEX CONCURRENTLY idx_events_search_tsv;` (also `transaction:false`) and retry the create.

### `ALTER TABLE ... ALTER COLUMN ... SET NOT NULL`

Postgres has to verify every row, scanning the whole table under `ACCESS EXCLUSIVE`. On a hot table this stalls.

**Safe pattern (PG 12+):** add a `CHECK (col IS NOT NULL) NOT VALID` first, run `ALTER TABLE … VALIDATE CONSTRAINT` (only takes `SHARE UPDATE EXCLUSIVE`), then `ALTER COLUMN SET NOT NULL` becomes `O(1)` because the constraint already proves the property.

```sql
ALTER TABLE events ADD CONSTRAINT events_title_not_null
  CHECK (title IS NOT NULL) NOT VALID;
ALTER TABLE events VALIDATE CONSTRAINT events_title_not_null;
ALTER TABLE events ALTER COLUMN title SET NOT NULL;
ALTER TABLE events DROP CONSTRAINT events_title_not_null;
```

### Cascading `ON DELETE SET NULL` / `ON DELETE CASCADE` on hot tables

A single `DELETE FROM connections WHERE id IN (...)` triggers an internal `UPDATE events SET connection_id = NULL WHERE connection_id IN (...)`. For a connection with 92k events that's a 13s blocking UPDATE — visible to ops as "the admin action hung the API."

**Safe pattern:** keep cascades for *small* parent tables only. For parents that fan out to events, watcher_window_events, or anything else 100k+ rows wide:

1. Make sure the **child FK column is indexed** (e.g. `idx_events_connection_id`) — without it, the cascade falls back to a seq scan and the UPDATE goes from 13s to minutes.
2. Manage the dependent nulling in application code with batched UPDATEs (e.g. 1k rows per loop, sleep between).
3. Run the parent `DELETE` only **after** the child rows are already nulled/orphaned — the cascade then has nothing to do and the delete is fast.

Indexing alone helps the cascade, but it doesn't eliminate the per-row WAL write; batching before the delete is what keeps the API responsive.

### Bare `DROP INDEX`

Takes `ACCESS EXCLUSIVE`. Use `DROP INDEX CONCURRENTLY` (also `transaction:false`).

---

## Operational checklist for any "big" migration

If the migration touches a table over ~100k rows or rebuilds a GIN/ivfflat index, before you open the PR:

1. **Time it locally against a copy of prod-sized data**, not a 1k-row dev DB. We have `psql "$DATABASE_URL" -c '\COPY ...'` paths to clone a single table for this purpose.
2. **Write the actual observed timing in the migration's header comment**, not a guess.
3. **Compare against the DB's `statement_timeout`** for the migration role. Prod is 60s. If your migration is close, restructure — don't ship hoping it'll fit.
4. **State the recovery plan** in the PR body: if the migration times out, what's the manual `SET statement_timeout=0; \i path/to/file` recipe?
5. **Verify the new app image still boots against an un-applied schema** by running it locally with the migration held back. With the boot-time schema-version assertion from [#767](https://github.com/lobu-ai/lobu/pull/767), it should refuse to start — that's good. The point is to confirm the refusal is loud and clean.

---

## When dbmate fails in prod

Symptoms: `summaries-app-lobu-migrate-*` pod in `Error` state, app pod in `CrashLoopBackOff` or stuck in a tight error loop. Confirm the schema state:

```sh
DB="$(... pull DATABASE_URL from secret ...)"
psql "$DB" -tAc "SELECT max(version) FROM schema_migrations"
psql "$DB" -tAc "SELECT 1 FROM information_schema.columns WHERE table_name='<table>' AND column_name='<col>'"
```

If a migration left no `schema_migrations` row, the safe recovery is to apply it manually with the cap lifted. Two paths depending on whether the migration uses `CONCURRENTLY`:

**Standard migration (no CONCURRENTLY):** one transaction with the timeouts lifted.

```sh
psql "$DB" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;
-- paste the migrate:up section here
INSERT INTO public.schema_migrations(version) VALUES ('<UTC-yyyymmddHHMMSS>');
COMMIT;
SQL
```

**`transaction:false` migration (any `CREATE/DROP INDEX CONCURRENTLY` or `REINDEX CONCURRENTLY`):** these can't run inside `BEGIN`. Use session-level `SET` and run statements one at a time. Verify success between each, then record the migration:

```sh
psql "$DB" <<'SQL'
SET statement_timeout = 0;
SET lock_timeout = 0;

-- one statement at a time, no BEGIN
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_foo ON bar (baz);
-- verify the index is valid before continuing:
SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_foo'::regclass;
-- if false: DROP INDEX CONCURRENTLY idx_foo; and rerun the create above.

-- once everything is healthy, record the migration in its own tiny txn:
BEGIN;
INSERT INTO public.schema_migrations(version) VALUES ('<UTC-yyyymmddHHMMSS>');
COMMIT;
SQL
```

Then `kubectl rollout restart deploy/<release>-lobu-app` to wipe cached prepared statements.

If the migration partially applied (column created, index missing, view missing), figure out which subset succeeded with `\d <table>` and run only the missing pieces.

---

## See also

- [PR #767](https://github.com/lobu-ai/lobu/pull/767) — the boot-time schema-version assertion that catches behind-DB images at startup.
- The post-incident commentary on the original migration ([#765](https://github.com/lobu-ai/lobu/pull/765)) for what "operational note" looks like when a migration's risks are flagged but not addressed.
