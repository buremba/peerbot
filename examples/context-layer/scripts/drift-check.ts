/**
 * The trust loop's drift canary.
 *
 * A `verified-query` entity pins a human-approved answer: the exact rollup SQL
 * plus the result rows it produced at approval time. This script re-reads the
 * SAME rollup LIVE from the warehouse (through the virtual-feed pushdown — the
 * path an analyst would actually use) and diffs it against the pinned
 * `approved_answer`.
 *
 * No drift  → the pinned answer is still trustworthy; quote it freely.
 * Drift     → the warehouse (or a definition) moved. Treat the pinned answer as
 *             stale and flag it for re-verification BEFORE anyone repeats a
 *             number that no longer matches reality.
 *
 * Run `bun run drift:simulate` first to see it catch a real change.
 *
 * Prereqs: `lobu run` is up here, and `seed:warehouse` + `seed` have run.
 */

import { connectLocalGateway, runSdkSource } from "./lib/gateway.ts";

const SANDBOX_SCRIPT = `
export default async (_ctx, client) => {
  // ── The pinned, approved answer ─────────────────────────────────────────
  const vqList = await client.entities.list({ entity_type: "verified-query" });
  const vq = (vqList.entities ?? [])[0];
  if (!vq) throw new Error("verified-query entity not found — run seed first");
  const pinned = (vq.metadata?.approved_answer ?? []).map((r) => ({
    month: String(r.month),
    cancellations: Number(r.cancellations),
  }));

  // ── The LIVE answer, re-read through the same virtual-feed pushdown ──────
  const feedList = await client.feeds.list({});
  const churnFeed = (feedList.feeds ?? []).find(
    (f) => f.kind === "virtual" && f.feed_key === "query",
  );
  if (!churnFeed) throw new Error("virtual churn feed not found — run seed first");
  const feedRead = await client.feeds.readMany({ feed_ids: [churnFeed.id] });
  const feedResult = (feedRead.results ?? []).find((r) => r.ok);
  if (!feedResult) throw new Error("virtual feed read failed: " + JSON.stringify(feedRead));
  const live = (feedResult.result.rows ?? []).map((r) => ({
    month: String(r.month),
    cancellations: Number(r.cancellations),
  }));

  // ── Diff by month ───────────────────────────────────────────────────────
  const pinnedByMonth = Object.fromEntries(pinned.map((r) => [r.month, r.cancellations]));
  const liveByMonth = Object.fromEntries(live.map((r) => [r.month, r.cancellations]));
  const months = [...new Set([...Object.keys(pinnedByMonth), ...Object.keys(liveByMonth)])].sort();

  const drift = [];
  for (const month of months) {
    const p = pinnedByMonth[month];
    const c = liveByMonth[month];
    if (p !== c) drift.push({ month, pinned: p ?? null, current: c ?? null });
  }

  return {
    question: vq.metadata?.question,
    approved_by: vq.metadata?.approved_by,
    approved_at: vq.metadata?.approved_at,
    pinned_rows: pinned.length,
    live_rows: live.length,
    drift,
  };
};
`;

interface DriftReport {
  question: string;
  approved_by: string;
  approved_at: string;
  pinned_rows: number;
  live_rows: number;
  drift: Array<{
    month: string;
    pinned: number | null;
    current: number | null;
  }>;
}

const gw = await connectLocalGateway();
console.log(`Connected to local gateway (org: ${gw.org})`);

const report = await runSdkSource<DriftReport>(gw, SANDBOX_SCRIPT);

console.log(`\nVerified query: "${report.question}"`);
console.log(
  `Approved by ${report.approved_by} on ${report.approved_at} ` +
    `(${report.pinned_rows} pinned rows vs ${report.live_rows} live rows)\n`
);

if (report.drift.length === 0) {
  console.log(
    "✅ No drift — the pinned answer still matches the live warehouse."
  );
} else {
  console.log(`⚠️  DRIFT DETECTED in ${report.drift.length} month(s):`);
  console.table(report.drift);
  console.log(
    "\nThe pinned answer is stale. Re-verify before quoting either side.\n" +
      "(This is the canary firing on purpose — run `bun run drift:simulate` mutated the warehouse.)"
  );
  process.exitCode = 1;
}
