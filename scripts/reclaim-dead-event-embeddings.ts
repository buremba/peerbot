#!/usr/bin/env bun

/**
 * One-time reclaim of `event_embeddings` rows belonging to superseded events
 * (issue #3066).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Until the insertEvent fix that ships alongside this script, nothing removed a
 * predecessor's vectors when it was superseded: both `DELETE FROM
 * event_embeddings` sites key on the row's OWN `event_id` before rewriting its
 * vector. Vector retrieval excludes superseded events, making those rows
 * unreachable, but `idx_events_embedding` is a plain ivfflat over the whole
 * table. With no partial predicate, they can still consume ANN scan budget.
 * The runtime fix stops the growth; this clears the backlog.
 *
 * ─── Exactly what it does ────────────────────────────────────────────────────
 * Walks `event_embeddings` forward by `event_id` and deletes every row whose
 * event has a non-NULL `superseded_by`. Each batch takes a whole event's rows
 * (all models, all chunks), so a batch boundary can never split one event and
 * strand half of it behind the cursor.
 *
 * `events` is append-only and is NOT touched. `event_embeddings` is a derived
 * index, so deleting from it does not touch the ledger invariant.
 *
 * ─── Safety ──────────────────────────────────────────────────────────────────
 *   - DRY-RUN by default; pass --execute to delete.
 *   - Idempotent and resumable: re-running is a no-op for rows already gone,
 *     and --from-event-id resumes from the cursor the last run printed.
 *   - Batched autocommit deletes with an optional --sleep-ms pause; no long
 *     transaction, no lock buildup, no table rewrite.
 *   - A regular VACUUM/autovacuum must reap the deleted tuples before their heap
 *     and index space is reusable. Physically shrinking relation files is a
 *     separate operator decision; this script does neither automatically.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   DATABASE_URL=... bun scripts/reclaim-dead-event-embeddings.ts
 *   DATABASE_URL=... bun scripts/reclaim-dead-event-embeddings.ts --execute
 *   DATABASE_URL=... bun scripts/reclaim-dead-event-embeddings.ts --execute \
 *     --batch 2000 --sleep-ms 250 --from-event-id 1234567 --max-batches 100
 *
 * Measure recall before and after with scripts/bench-vector-recall.sql.
 */

import { parseArgs as parseNodeArgs } from "node:util";
import { getDb } from "../packages/server/src/db/client";

const { values: args } = parseNodeArgs({
  options: {
    execute: { type: "boolean", default: false },
    batch: { type: "string", default: "1000" },
    "sleep-ms": { type: "string", default: "0" },
    "from-event-id": { type: "string", default: "0" },
    "max-batches": { type: "string" },
  },
});

const EXECUTE = Boolean(args.execute);

function integerOption(
  name: string,
  value: string | undefined,
  minimum: number
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function eventIdOption(value: string | undefined): string {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error("--from-event-id must be a non-negative integer");
  }
  return BigInt(value).toString();
}

const BATCH = integerOption("batch", args.batch, 1);
const SLEEP_MS = integerOption("sleep-ms", args["sleep-ms"], 0);
const FROM_EVENT_ID = eventIdOption(args["from-event-id"]);
const MAX_BATCHES =
  args["max-batches"] === undefined
    ? Number.POSITIVE_INFINITY
    : integerOption("max-batches", args["max-batches"], 1);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const sql = getDb();

  const [before] = await sql<{
    total: string;
    live: string;
    dead: string;
  }>`
		SELECT count(*)::text AS total,
		       count(*) FILTER (WHERE e.superseded_by IS NULL)::text AS live,
		       count(*) FILTER (WHERE e.superseded_by IS NOT NULL)::text AS dead
		FROM event_embeddings emb
		JOIN events e ON e.id = emb.event_id
	`;
  console.log(
    `event_embeddings: ${before.total} rows — ${before.live} live, ${before.dead} dead (superseded)`
  );
  if (!EXECUTE) {
    console.log("DRY RUN — pass --execute to delete. Nothing was written.");
  }

  let cursor = FROM_EVENT_ID;
  let deleted = 0;
  let batches = 0;
  const startedAt = Date.now();

  for (;;) {
    if (batches >= MAX_BATCHES) {
      console.log(`stopping at --max-batches=${MAX_BATCHES}`);
      break;
    }

    // DISTINCT event_id, not raw rows: taking a whole event's chunk/model set
    // per batch keeps the cursor safe to advance to max(event_id) — a raw-row
    // window could split one event across the boundary and leave the remainder
    // permanently behind the cursor.
    const victims = await sql<{ event_id: string }>`
			SELECT DISTINCT emb.event_id
			FROM event_embeddings emb
			JOIN events e ON e.id = emb.event_id
			WHERE emb.event_id > ${cursor}
			  AND e.superseded_by IS NOT NULL
			ORDER BY emb.event_id
			LIMIT ${BATCH}
		`;
    if (victims.length === 0) break;

    const ids = victims.map((v) => v.event_id);
    const nextCursor = ids[ids.length - 1] as string;
    // The pool runs with fetch_types:false, so a raw JS array bound as a param
    // serializes to a malformed literal even with a ::bigint[] cast.
    const idsLiteral = `{${ids.join(",")}}`;

    if (EXECUTE) {
      const removed = await sql<{ event_id: string }>`
				DELETE FROM event_embeddings
				WHERE event_id = ANY(${idsLiteral}::bigint[])
				RETURNING event_id::text AS event_id
			`;
      deleted += removed.length;
    } else {
      const [counted] = await sql<{ n: string }>`
				SELECT count(*)::text AS n
				FROM event_embeddings
				WHERE event_id = ANY(${idsLiteral}::bigint[])
			`;
      deleted += Number(counted.n);
    }

    cursor = nextCursor;
    batches++;
    if (batches % 25 === 0) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `  batch ${batches}: ${deleted} rows ${EXECUTE ? "deleted" : "would be deleted"}, cursor=${cursor} (${elapsed}s)`
      );
    }
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `${EXECUTE ? "deleted" : "would delete"} ${deleted} vector row(s) across ${batches} batch(es) in ${elapsed}s`
  );
  if (EXECUTE) {
    console.log(`resume with --from-event-id ${cursor}`);
    const [after] = await sql<{ total: string; dead: string }>`
			SELECT count(*)::text AS total,
			       count(*) FILTER (WHERE e.superseded_by IS NOT NULL)::text AS dead
			FROM event_embeddings emb
			JOIN events e ON e.id = emb.event_id
		`;
    console.log(
      `event_embeddings now: ${after.total} rows, ${after.dead} dead`
    );
    console.log(
      "run VACUUM (ANALYZE) event_embeddings before the after-benchmark so deleted index tuples are reaped; physical file shrinking is a separate operator decision."
    );
  }

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
