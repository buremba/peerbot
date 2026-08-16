#!/usr/bin/env bun

/**
 * One-time backfill of `runs.outcome` (migration 20260807000000_runs_outcome).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Terminal-status writers stamp `outcome` at write time going forward; rows
 * that existed before the migration carry NULL. This fills history by calling
 * THE classifier (packages/server/src/runs/run-outcome.ts) per row — never a
 * SQL re-encoding of its rules — so backfilled rows and live rows agree by
 * construction.
 *
 * ─── Exactly what it does ────────────────────────────────────────────────────
 * Walks the rows the live write path stamps — Automation runs in any terminal
 * status (`completed`/`failed`/`timeout`) plus `timeout` rows of every
 * run_type (the shared reapers stamp those message-independently) — by id
 * range in batches, classifies each row from (status, error_message) in TS,
 * and writes the outcomes back with one UPDATE ... FROM (VALUES ...) per
 * batch. Only rows still NULL are touched, so the script is idempotent and
 * resumable.
 *
 * Non-automation `completed`/`failed` rows are NOT walked: their live writers
 * don't stamp either (agent_error/scoreable are agent-run concepts and the
 * classifier's message patterns are tuned on Automation failures), so walking
 * them here would mint labels the write path never produces. `cancelled` rows
 * are skipped (classifier returns null: a human choice is neither infra nor
 * agent evidence) — same as the write path. Historical non-automation dispatch
 * failures stay NULL (they are plain `failed` rows we cannot identify by
 * message), unlike future ones which poll.ts stamps.
 *
 * ─── Safety ──────────────────────────────────────────────────────────────────
 *   - DRY-RUN by default; pass --execute to write.
 *   - Plain autocommit statements, small batches (default 5000).
 *
 * DATABASE_URL must point at the target database.
 */

import { parseArgs as parseNodeArgs } from "node:util";
import {
  getDb,
  pgBigintArray,
  pgTextArray,
} from "../packages/server/src/db/client";
import {
  classifyRunOutcome,
  type RunOutcome,
} from "../packages/server/src/runs/run-outcome";

const { values: args } = parseNodeArgs({
  options: {
    execute: { type: "boolean", default: false },
    batch: { type: "string", default: "5000" },
    "start-id": { type: "string", default: "0" },
  },
});

const EXECUTE = Boolean(args.execute);
const BATCH = Math.max(100, Number(args.batch ?? 5000));
let cursor = Math.max(0, Number(args["start-id"] ?? 0));

const sql = getDb();

let scanned = 0;
const written: Record<RunOutcome, number> = {
  infra_error: 0,
  agent_error: 0,
  scoreable: 0,
};

for (;;) {
  const rows = (await sql`
    SELECT id, status, error_message
    FROM runs
    WHERE id > ${cursor}
      AND outcome IS NULL
      AND (
        (run_type = 'automation' AND status IN ('completed', 'failed'))
        OR status = 'timeout'
      )
    ORDER BY id ASC
    LIMIT ${BATCH}
  `) as unknown as Array<{
    id: number | string;
    status: string;
    error_message: string | null;
  }>;
  if (rows.length === 0) break;

  cursor = Number(rows[rows.length - 1].id);
  scanned += rows.length;

  const classified = rows.flatMap((row) => {
    const outcome = classifyRunOutcome({
      status: row.status,
      errorMessage: row.error_message,
    });
    return outcome ? [{ id: Number(row.id), outcome }] : [];
  });
  for (const c of classified) written[c.outcome]++;

  if (EXECUTE && classified.length > 0) {
    // fetch_types:false — never bind a raw JS array; format `{...}` literals
    // (same convention as insert-event.ts / pgTextArray).
    const ids = pgBigintArray(classified.map((c) => c.id));
    const outcomes = pgTextArray(classified.map((c) => c.outcome));
    await sql`
      UPDATE runs r
      SET outcome = v.outcome
      FROM (
        SELECT * FROM unnest(${ids}::bigint[], ${outcomes}::text[]) AS t(id, outcome)
      ) v
      WHERE r.id = v.id
        AND r.outcome IS NULL
    `;
  }

  console.log(
    `${EXECUTE ? "wrote" : "dry-run"} through id ${cursor} — scanned ${scanned}, ` +
      `infra ${written.infra_error} / agent ${written.agent_error} / scoreable ${written.scoreable}`
  );
}

console.log(
  `${EXECUTE ? "DONE" : "DRY-RUN DONE (pass --execute to write)"}: scanned ${scanned}, ` +
    `infra_error ${written.infra_error}, agent_error ${written.agent_error}, scoreable ${written.scoreable}`
);
process.exit(0);
