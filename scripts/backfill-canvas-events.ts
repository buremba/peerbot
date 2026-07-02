#!/usr/bin/env tsx
/**
 * One-off backfill CLI: fold historical `watcher_windows` rows into
 * canvas-on-events (canvas entity + canvas_state ROOT event + re-keyed
 * window_id references). Thin wrapper over the package function
 * `backfillCanvasEvents` (packages/server/src/watchers), which is exercised on a
 * real DB by the watcher integration tests. See that module for full semantics.
 *
 * Idempotent (the idx_canvas_chain_root unique index makes replays no-ops), so
 * it is safe to re-run. NEVER touches tab_event/tab_snapshot events — every
 * query is scoped to watcher_windows / semantic_type='canvas_state'.
 *
 *   tsx scripts/backfill-canvas-events.ts                 # dry-run, all orgs
 *   tsx scripts/backfill-canvas-events.ts --execute       # write, all orgs
 *   tsx scripts/backfill-canvas-events.ts --org <id>      # filter by org
 *
 * DATABASE_URL must point at the target database.
 */

import { getDb } from "../packages/server/src/db/client";
import { backfillCanvasEvents } from "../packages/server/src/watchers/backfill-canvas-events";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const orgIdx = argv.indexOf("--org");
  const org = orgIdx >= 0 ? (argv[orgIdx + 1] ?? null) : null;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const sql = getDb();
  try {
    const report = await backfillCanvasEvents({
      db: sql,
      org,
      execute,
      log: (m) => console.log(m),
    });
    console.log(
      `\nDone. windows=${report.windows} ` +
        `roots ${execute ? "created" : "would create"}=${report.rootsCreated} ` +
        `existing=${report.rootsExisting} ` +
        `window_events.watcher_id filled=${report.windowEventsWatcherIdFilled} ` +
        `skipped=${report.skipped}`
    );
    if (!execute && report.rootsCreated > 0)
      console.log("DRY-RUN only — re-run with --execute to write.");
  } finally {
    await sql.end?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[backfill-canvas-events] FAILED:", err);
    process.exit(1);
  });
}
