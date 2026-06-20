/**
 * Backfill the run_usage ledger from transcript snapshots already in Postgres.
 *
 * The cost ledger only starts collecting at deploy time, but every past run's
 * full transcript is already stored in agent_transcript_snapshot — so we can
 * reconstruct historical COST (tokens + usd) from it with no loss. The
 * per-watcher/user/source DIMENSIONS are best-effort: they're read from the
 * runs row, which retention may already have pruned for old runs — those rows
 * land with null dims (cost still correct). Idempotent (ON CONFLICT), safe to
 * re-run.
 *
 *   DATABASE_URL=... bun packages/server/scripts/backfill-run-usage.ts
 */

import { closeDbSingleton } from "../src/db/client.js";
import { backfillRunUsage } from "../src/cost/run-usage.js";

async function main() {
  const batchSize = Number(process.env.BACKFILL_BATCH_SIZE ?? "200");
  const result = await backfillRunUsage({ batchSize });
  console.log(
    `[backfill-run-usage] scanned=${result.scanned} written=${result.written} failed=${result.failed}`
  );
}

main()
  .catch((err) => {
    console.error("[backfill-run-usage] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDbSingleton());
