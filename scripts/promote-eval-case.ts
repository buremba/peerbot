#!/usr/bin/env bun

/**
 * Promote a real Automation run into a reusable eval case, and optionally replay
 * it straight away.
 *
 *   bun scripts/promote-eval-case.ts --run 876554 --expect "names the 4 dupes"
 *   bun scripts/promote-eval-case.ts --run 876554 --key regression-a --replay
 *
 * A script rather than an agent-facing tool for the same reason
 * `queue-eval-run.ts` is: the trigger surface (SDK verb vs internal route) is
 * its own design decision and has not been made. This exists so the case set is
 * buildable today, and so the promote path is exercisable end to end.
 *
 * DATABASE_URL must point at the target database.
 */

import { parseArgs as parseNodeArgs } from "node:util";
import { getDb } from "../packages/server/src/db/client";
import {
  promoteEvalCase,
  replayEvalCase,
} from "../packages/server/src/runs/eval-cases";

const { values: args } = parseNodeArgs({
  options: {
    run: { type: "string" },
    key: { type: "string", default: "default" },
    expect: { type: "string" },
    replay: { type: "boolean", default: false },
  },
});

const sourceRunId = Number(args.run);
if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 1) {
  console.error("--run <automation run id> is required");
  process.exit(1);
}

const sql = getDb();
const result = await promoteEvalCase(
  {
    sourceRunId,
    caseKey: args.key,
    expectation: args.expect ?? null,
  },
  sql
);

if (!result.ok) {
  console.error(
    `Could not promote automation run ${sourceRunId}: ${result.reason}.`
  );
  process.exit(1);
}

const { evalCase, created } = result;
console.log(
  created
    ? `Promoted automation run ${evalCase.sourceRunId} into eval case ${evalCase.entityId} (automation ${evalCase.automationId}, key "${evalCase.caseKey}").`
    : `Eval case ${evalCase.entityId} already covers automation run ${evalCase.sourceRunId} key "${evalCase.caseKey}".`
);

if (args.replay) {
  const run = await replayEvalCase(evalCase.entityId, sql);
  if (!run) {
    console.error(`Case ${evalCase.entityId} could not be replayed.`);
    process.exit(1);
  }
  console.log(
    run.created
      ? `Queued eval run ${run.runId} for case ${evalCase.entityId}.`
      : `Eval run ${run.runId} for case ${evalCase.entityId} is already in flight.`
  );
}

process.exit(0);
