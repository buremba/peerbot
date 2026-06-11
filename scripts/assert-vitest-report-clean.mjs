#!/usr/bin/env node
/**
 * Fail-closed guard for vitest exit codes in CI (#1216).
 *
 * vitest's exit code is not trustworthy on its own: anything that hooks
 * `beforeExit` in the main process (async-exit-hook, registered as a side
 * effect of importing `embedded-postgres`, force-exits 0) can overwrite a
 * failing `process.exitCode` after the summary prints — CI run 27363592280
 * went green with "Test Files 5 failed". The root cause is unhooked in
 * src/__tests__/setup/embedded-postgres-backend.ts, but the gate must not
 * depend on every future import staying side-effect-free.
 *
 * Usage: run vitest with `--reporter=json --outputFile.json=<path>`, then
 *   node scripts/assert-vitest-report-clean.mjs <path>
 * Exits non-zero unless the report exists, parses, ran at least one test,
 * and recorded zero failures.
 */
import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error(
    "[vitest-guard] usage: assert-vitest-report-clean.mjs <report.json>"
  );
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf-8"));
} catch (err) {
  console.error(
    `[vitest-guard] FAIL-CLOSED: cannot read/parse ${reportPath}: ${err.message}`
  );
  console.error(
    "[vitest-guard] (a crashed or interrupted vitest run never writes the report)"
  );
  process.exit(1);
}

const { success, numTotalTests, numFailedTests, numFailedTestSuites } = report;
console.log(
  `[vitest-guard] report: success=${success} total=${numTotalTests} ` +
    `failedTests=${numFailedTests} failedSuites=${numFailedTestSuites}`
);

if (success !== true || numFailedTests !== 0 || numFailedTestSuites !== 0) {
  console.error(
    "[vitest-guard] FAIL: vitest reported failures (regardless of its exit code)"
  );
  process.exit(1);
}
if (!Number.isInteger(numTotalTests) || numTotalTests < 1) {
  console.error(
    "[vitest-guard] FAIL-CLOSED: zero tests ran — refusing to treat that as green"
  );
  process.exit(1);
}
console.log("[vitest-guard] OK");
