/**
 * Per-run usage ledger writer.
 *
 * Parses a completed run's transcript snapshot into per-model token sums,
 * prices each segment (see ./price-usage), and writes one denormalized
 * `run_usage` row — the authoritative source for showback + caps. Written at
 * the snapshot seam (transcript-routes POST), so it inherits that path's
 * exactly-once guarantee: we only land a usage row when the snapshot insert
 * itself won the race, and the row's own UNIQUE(run_id) is a second guard.
 */

import {
  aggregateUsageByModel,
  createLogger,
  type ModelUsageAggregate,
  parseSessionEntries,
} from "@lobu/core";
import { getDb } from "../db/client.js";
import { priceUsage } from "./price-usage.js";

const logger = createLogger("run-usage");

export interface RunUsageBreakdownEntry {
  provider: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number | null;
  unpriced: boolean;
}

export interface ComputedRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Total USD, or null when any segment is unpriced (don't trust a partial). */
  usd: number | null;
  unpriced: boolean;
  /** pi's flat on-disk cost summed across the run (reference / cross-check). */
  piCostUsd: number;
  /** The highest-token model, used as the row's primary provider/model. */
  provider: string | null;
  model: string | null;
  breakdown: RunUsageBreakdownEntry[];
}

/**
 * Pure: snapshot JSONL -> priced totals + per-model breakdown. `at` (the run's
 * completion time) drives genai-prices' time-versioned pricing, so a backfilled
 * run prices at the rate in effect on its own date.
 */
export function computeRunUsage(args: {
  snapshotJsonl: string;
  at?: Date;
}): ComputedRunUsage {
  const { entries } = parseSessionEntries(args.snapshotJsonl);
  const segments = aggregateUsageByModel(entries);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let piCostUsd = 0;
  let pricedUsd = 0;
  let anyUnpriced = false;
  const breakdown: RunUsageBreakdownEntry[] = [];
  let primary: ModelUsageAggregate | null = null;
  let primaryTokens = -1;

  for (const seg of segments) {
    const priced = priceUsage({
      usage: {
        input: seg.input,
        output: seg.output,
        cacheRead: seg.cacheRead,
        cacheWrite: seg.cacheWrite,
      },
      provider: seg.provider ?? "",
      model: seg.model ?? "",
      at: args.at,
    });
    inputTokens += seg.input;
    outputTokens += seg.output;
    cacheReadTokens += seg.cacheRead;
    cacheWriteTokens += seg.cacheWrite;
    piCostUsd += seg.piCostUsd;
    if (priced.usd === null) {
      anyUnpriced = true;
    } else {
      pricedUsd += priced.usd;
    }
    const segTokens = seg.input + seg.output + seg.cacheRead + seg.cacheWrite;
    if (segTokens > primaryTokens) {
      primaryTokens = segTokens;
      primary = seg;
    }
    breakdown.push({
      provider: seg.provider ?? null,
      model: seg.model ?? null,
      input: seg.input,
      output: seg.output,
      cacheRead: seg.cacheRead,
      cacheWrite: seg.cacheWrite,
      usd: priced.usd,
      unpriced: priced.unpriced,
    });
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // If any segment is unpriced we have no trustworthy total — store NULL
    // (+ unpriced=true) rather than a misleadingly-low partial sum.
    usd: anyUnpriced ? null : pricedUsd,
    unpriced: anyUnpriced,
    piCostUsd,
    provider: primary?.provider ?? null,
    model: primary?.model ?? null,
    breakdown,
  };
}

/**
 * Parse + price a run's snapshot and upsert its `run_usage` row. Throws on DB
 * error so callers decide the policy: the live snapshot route swallows it
 * (best-effort accounting must never fail the snapshot write); the backfill
 * surfaces it per row.
 */
export async function recordRunUsage(args: {
  organizationId: string;
  agentId: string;
  conversationId: string;
  runId: number;
  terminalStatus: string;
  snapshotJsonl: string;
  /** Backfill passes the snapshot's created_at; live path omits (DB now()). */
  occurredAt?: Date;
}): Promise<void> {
  const sql = getDb();
  const computed = computeRunUsage({
    snapshotJsonl: args.snapshotJsonl,
    at: args.occurredAt,
  });

  // Dimensions not on the snapshot/JWT but present on the runs row (still
  // there at completion time, before retention prunes the queue).
  const dims = await sql<{
    watcher_id: number | null;
    created_by_user_id: string | null;
    run_type: string | null;
  }>`
    SELECT watcher_id, created_by_user_id, run_type
    FROM public.runs WHERE id = ${args.runId} LIMIT 1
  `;
  const watcherId = dims[0]?.watcher_id ?? null;
  const userId = dims[0]?.created_by_user_id ?? null;
  const source = dims[0]?.run_type ?? null;

  const occurredAt = args.occurredAt ?? sql`now()`;

  await sql`
    INSERT INTO public.run_usage (
      organization_id, agent_id, conversation_id, run_id,
      user_id, watcher_id, source, provider, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      usd, unpriced, pi_cost_usd, model_breakdown, terminal_status, occurred_at
    ) VALUES (
      ${args.organizationId}, ${args.agentId}, ${args.conversationId}, ${args.runId},
      ${userId}, ${watcherId}, ${source}, ${computed.provider}, ${computed.model},
      ${computed.inputTokens}, ${computed.outputTokens},
      ${computed.cacheReadTokens}, ${computed.cacheWriteTokens},
      ${computed.usd}, ${computed.unpriced}, ${computed.piCostUsd},
      ${sql.json(computed.breakdown)}, ${args.terminalStatus}, ${occurredAt}
    )
    ON CONFLICT (run_id) DO NOTHING
  `;

  logger.debug(
    `run_usage run=${args.runId} in=${computed.inputTokens} out=${computed.outputTokens} ` +
      `cacheR=${computed.cacheReadTokens} usd=${computed.usd ?? "null"} unpriced=${computed.unpriced}`
  );
}

/**
 * Reconstruct `run_usage` for past runs from the transcript snapshots already
 * in Postgres. Pages forward by snapshot id (NOT by the missing-row predicate)
 * so a row that fails to price can't stall the walk, and prices each run at its
 * own snapshot `created_at`. Idempotent: `recordRunUsage` upserts ON CONFLICT,
 * so re-running is safe.
 */
export async function backfillRunUsage(opts?: {
  batchSize?: number;
}): Promise<{ scanned: number; written: number; failed: number }> {
  const sql = getDb();
  const batchSize = opts?.batchSize ?? 200;
  let afterId = 0;
  let scanned = 0;
  let written = 0;
  let failed = 0;

  for (;;) {
    const rows = await sql<{
      snap_id: number;
      organization_id: string;
      agent_id: string;
      conversation_id: string;
      run_id: number;
      terminal_status: string;
      snapshot_jsonl: string;
      created_at: Date;
    }>`
      SELECT s.id AS snap_id, s.organization_id, s.agent_id, s.conversation_id,
             s.run_id, s.terminal_status, s.snapshot_jsonl, s.created_at
      FROM public.agent_transcript_snapshot s
      LEFT JOIN public.run_usage u ON u.run_id = s.run_id
      WHERE u.run_id IS NULL AND s.id > ${afterId}
      ORDER BY s.id
      LIMIT ${batchSize}
    `;
    if (rows.length === 0) break;
    for (const r of rows) {
      afterId = r.snap_id;
      scanned++;
      try {
        await recordRunUsage({
          organizationId: r.organization_id,
          agentId: r.agent_id,
          conversationId: r.conversation_id,
          runId: r.run_id,
          terminalStatus: r.terminal_status,
          snapshotJsonl: r.snapshot_jsonl,
          occurredAt: r.created_at,
        });
        written++;
      } catch (err) {
        failed++;
        logger.warn(
          `backfill run ${r.run_id} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  logger.info(
    `run_usage backfill complete: scanned=${scanned} written=${written} failed=${failed}`
  );
  return { scanned, written, failed };
}
