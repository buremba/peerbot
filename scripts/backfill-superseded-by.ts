#!/usr/bin/env tsx
/**
 * One-off backfill CLI: populate `events.superseded_by` from the existing
 * `supersedes_event_id` edges. Thin wrapper over the package function
 * `backfillSupersededBy` (packages/server/src/events), which is exercised on a
 * real DB by its integration test (vitest = the proven isolate runner). See
 * that module for full semantics and the Stage 2 (view flip) SQL.
 *
 * Batched + resumable + idempotent, so it is safe to run against a LIVE prod
 * database and safe to re-run after an interrupt.
 *
 *   tsx scripts/backfill-superseded-by.ts                       # dry-run (count only)
 *   tsx scripts/backfill-superseded-by.ts --execute             # write
 *   tsx scripts/backfill-superseded-by.ts --execute --batch 5000 --sleep 200
 *
 * DATABASE_URL must point at the target database.
 */

import { getDb } from "../packages/server/src/db/client";
import { backfillSupersededBy } from "../packages/server/src/events/backfill-superseded-by";

function numArg(argv: string[], flag: string): number | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const raw = argv[idx + 1];
  const n = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) {
    // A malformed flag silently falling back to the default is dangerous for a
    // production backfill ("--batch foo" must not mean 5000) — fail fast.
    throw new Error(
      `${flag} requires a numeric value (got ${JSON.stringify(raw ?? null)})`
    );
  }
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const batchSize = numArg(argv, "--batch");
  const sleepMs = numArg(argv, "--sleep");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const sql = getDb();
  try {
    const report = await backfillSupersededBy({
      db: sql,
      execute,
      batchSize,
      sleepMs,
      log: (m) => console.log(m),
    });
    console.log(
      `\nDone. ${report.filled} row(s) ${execute ? "filled" : "would fill"} ` +
        `across ${report.batches} batch(es).`
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
