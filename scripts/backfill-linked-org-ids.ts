#!/usr/bin/env bun

/**
 * One-time backfill of `events.linked_org_ids` (migration
 * 20260804170000_events_linked_org_ids).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Org-scoped reads (content feed, derived views, data sources) used a per-row
 * OR/EXISTS bridge — "any of entity_ids is one of our entities, or the
 * producing connection is ours" — which defeated every index and cost ~1-2s
 * per query on prod. The migration added `linked_org_ids text[]` folding both
 * bridge branches into one GIN-indexed column, computed AT WRITE TIME by the
 * insert path going forward. Rows that existed before the migration carry
 * NULL; this backfill fills them with the exact same expression.
 *
 * ─── Ordering contract ───────────────────────────────────────────────────────
 * Run this to completion BEFORE flipping LOBU_LINKED_ORG_SCOPE=1: pre-backfill
 * rows carry NULL and would lose bridge visibility under the new predicate.
 *
 * ─── Exactly what it does ────────────────────────────────────────────────────
 * Walks events by id range in batches. Per batch, two statements:
 *   1. Rows with no entity_ids and no connection_id get '{}' (no probe).
 *   2. The rest get DISTINCT orgs of their stamped entities plus their
 *      connection's org, minus the event's own org — the same computation the
 *      insert path writes (packages/server/src/utils/insert-event.ts).
 * Only rows still NULL are touched, so the script is idempotent and
 * resumable (kill it anytime; rerun continues where it stopped).
 *
 * ─── Safety ──────────────────────────────────────────────────────────────────
 *   - DRY-RUN by default; pass --execute to write.
 *   - Plain autocommit statements (no long transaction, no lock buildup).
 *   - Batch size is small (default 5000) so no statement trips
 *     statement_timeout or blocks writers.
 *
 * DATABASE_URL must point at the target database.
 */

import { parseArgs as parseNodeArgs } from "node:util";
import { getDb } from "../packages/server/src/db/client";

const { values: args } = parseNodeArgs({
  options: {
    execute: { type: "boolean", default: false },
    batch: { type: "string", default: "5000" },
    "start-id": { type: "string", default: "0" },
  },
});

const EXECUTE = Boolean(args.execute);
const BATCH = Math.max(100, Number(args.batch ?? 5000));
const START_ID = Number(args["start-id"] ?? 0);

async function main() {
  const sql = getDb();

  const bounds = await sql`SELECT min(id) AS lo, max(id) AS hi FROM events`;
  const lo0 = Number(bounds[0]?.lo ?? 0);
  const hi = Number(bounds[0]?.hi ?? 0);
  if (hi === 0) {
    console.log("no events; nothing to do");
    return;
  }
  let lo = Math.max(lo0, START_ID);

  const remaining = await sql`
		SELECT count(*)::int AS n FROM events WHERE linked_org_ids IS NULL AND id >= ${lo}
	`;
  console.log(
    `events range ${lo0}..${hi}, backfill starts at ${lo}, ${remaining[0]?.n} rows still NULL`
  );
  if (!EXECUTE) {
    console.log("DRY-RUN: nothing written. Pass --execute to backfill.");
    return;
  }

  const started = Date.now();
  let done = 0;

  for (; lo <= hi; lo += BATCH) {
    const batchHi = Math.min(lo + BATCH - 1, hi);

    // 1. Unlinked rows: no entities, no connection → empty set, no probes.
    const empty = await sql`
			UPDATE events
			SET linked_org_ids = '{}'::text[]
			WHERE id BETWEEN ${lo} AND ${batchHi}
			  AND linked_org_ids IS NULL
			  AND (entity_ids IS NULL OR cardinality(entity_ids) = 0)
			  AND connection_id IS NULL
		`;

    // 2. Linked rows: DISTINCT orgs of stamped entities + connection org,
    //    minus the event's own org. Same expression as the insert path.
    const linked = await sql`
			UPDATE events e
			SET linked_org_ids = (
				SELECT COALESCE(array_agg(DISTINCT x.o), '{}'::text[])
				FROM (
					SELECT ent.organization_id AS o
					FROM public.entities ent
					WHERE ent.id = ANY(e.entity_ids)
					UNION ALL
					SELECT c.organization_id AS o
					FROM public.connections c
					WHERE c.id = e.connection_id
				) x
				WHERE x.o IS NOT NULL
				  AND (x.o <> e.organization_id OR e.organization_id IS NULL)
			)
			WHERE e.id BETWEEN ${lo} AND ${batchHi}
			  AND e.linked_org_ids IS NULL
		`;

    done += empty.count + linked.count;
    if (empty.count + linked.count > 0 || batchHi >= hi) {
      const pct = Math.min(100, ((batchHi - lo0 + 1) / (hi - lo0 + 1)) * 100);
      console.log(
        `  ${lo}..${batchHi}: ${empty.count} empty + ${linked.count} linked (total ${done}, ${pct.toFixed(1)}%, ${Math.round((Date.now() - started) / 1000)}s)`
      );
    }
  }

  const left =
    await sql`SELECT count(*)::int AS n FROM events WHERE linked_org_ids IS NULL`;
  console.log(
    `done: ${done} rows backfilled in ${Math.round((Date.now() - started) / 1000)}s; NULL rows left: ${left[0]?.n}`
  );
  if (Number(left[0]?.n) === 0) {
    console.log("safe to flip LOBU_LINKED_ORG_SCOPE=1");
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
