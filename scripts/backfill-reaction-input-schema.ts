#!/usr/bin/env tsx
/**
 * One-off backfill CLI: populate `watchers.reaction_input_schema` for reactions
 * that predate the reaction-contract feature. Thin wrapper over the package
 * function `backfillReactionInputSchema` (packages/server/src/watchers), which is
 * exercised on a real DB by its integration test (vitest = the proven isolate
 * runner). See that module for full semantics.
 *
 * The extractor loads the `isolated-vm` native addon (V8-only) so this runs under
 * node (NOT bun). For prod, run it from the server runtime post-deploy.
 *
 *   tsx scripts/backfill-reaction-input-schema.ts                 # dry-run, all orgs
 *   tsx scripts/backfill-reaction-input-schema.ts --execute       # write, all orgs
 *   tsx scripts/backfill-reaction-input-schema.ts --org <id>      # filter by org
 *
 * DATABASE_URL must point at the target database.
 */

import { getDb } from "../packages/server/src/db/client";
import { backfillReactionInputSchema } from "../packages/server/src/watchers/backfill-reaction-input-schema";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const orgIdx = argv.indexOf("--org");
  const org = orgIdx >= 0 ? (argv[orgIdx + 1] ?? null) : null;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const sql = getDb();
  try {
    const report = await backfillReactionInputSchema({
      db: sql,
      org,
      execute,
      log: (m) => console.log(m),
    });
    console.log(
      `\nDone. ${report.filled} group(s) ${execute ? "filled" : "would fill"}, ` +
        `${report.noInput} have no \`input\` (stay NULL).`
    );
    if (!execute && report.filled > 0)
      console.log("DRY-RUN only — re-run with --execute to write.");
  } finally {
    await sql.end?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[backfill-reaction-input-schema] FAILED:", err);
    process.exit(1);
  });
}
