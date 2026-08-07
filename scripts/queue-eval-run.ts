#!/usr/bin/env bun

/**
 * Queue an eval replay of a real Behavior run.
 *
 *   bun scripts/queue-eval-run.ts --run 873146
 *   bun scripts/queue-eval-run.ts --run 873146 --key attempt-2
 *
 * The replay reuses the source run's frozen dispatch payload and is dispatched
 * by the normal Behavior dispatcher. Because its `run_type` is `behavior_eval`,
 * the server derives `executionMode = 'capture'` for the session, so the agent
 * runs for real but its side effects are recorded rather than performed.
 *
 * A script rather than an agent-facing tool on purpose: the trigger surface
 * (SDK verb vs internal route) needs its own design sign-off and has not had
 * it. PR 3 added the promote flow (`promote-eval-case.ts`) under the same
 * constraint. This exists so the capture path is exercisable end to end today.
 *
 * DATABASE_URL must point at the target database.
 */

import { parseArgs as parseNodeArgs } from "node:util";
import { getDb } from "../packages/server/src/db/client";
import { createEvalRun } from "../packages/server/src/runs/eval-runs";

const { values: args } = parseNodeArgs({
  options: {
    run: { type: "string" },
    key: { type: "string", default: "default" },
  },
});

const sourceRunId = Number(args.run);
if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 1) {
  console.error("--run <behavior run id> is required");
  process.exit(1);
}

const sql = getDb();
const result = await createEvalRun(
  { sourceRunId, caseKey: String(args.key) },
  sql
);

if (!result) {
  console.error(
    `No eval run queued for source run ${sourceRunId} — see the log line above for why.`
  );
  process.exit(1);
}

console.log(
  result.created
    ? `Queued eval run ${result.runId} replaying behavior run ${result.sourceRunId} (behavior ${result.behaviorId}).`
    : `Eval run ${result.runId} for behavior run ${result.sourceRunId} is already in flight.`
);
process.exit(0);
