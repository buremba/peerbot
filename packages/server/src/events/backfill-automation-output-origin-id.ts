/**
 * One-off backfill: re-stamp `events.origin_id` on Automation event-output rows
 * that were written with a POSITIONAL origin_id.
 *
 * Context: `persistAutomationEventOutput` used to name every row
 * `automation_<id>_<output>_canvas_<revision>_<arrayIndex>`. An hourly Automation's
 * runs all append to the same Canvas revision, so item N of every run got the
 * same origin_id while being a different source item. Prod Automation 71 put 8
 * unrelated posts under `automation_71_signals_canvas_4819569_4`. The rows are all
 * legitimate and correctly deduplicated by their idempotency key — only the
 * identifier collided, which broke the rule that `origin_id` is stable source
 * identity (resolving one returned a set of unrelated events).
 *
 * This fills the historical rows with the same value the fixed writer would have
 * produced, by calling `automationOutputOriginId` rather than reimplementing the
 * encoding in SQL — a backfill that mirrors an encoding drifts from the writer
 * the moment either side changes.
 *
 * `origin_id` here is IDENTITY METADATA, not payload, and these rows carry no
 * `connection_id`, so they sit outside the (connection_id, origin_id) dedup path
 * and its index. Re-stamping therefore changes no content and cannot violate the
 * append-only invariant (precedent: `superseded_by`, `search_tsv`).
 *
 * Only rows whose `_lobu_idempotency_key` carries a model-supplied source key
 * (`automation:<id>:output:<name>:key:<sourceKey>`) are touched. A row keyed
 * positionally (`...:item:<N>`) has no stable identity to recover, so its
 * positional origin_id is already the honest name for it and is left alone.
 *
 * Idempotent + resumable: a row is only updated when its stored origin_id
 * differs from the derived one, so re-running after an interrupt — or after the
 * fixed writer already stamped new rows correctly — skips them.
 */

import { type DbClient, pgBigintArray, pgTextArray } from '../db/client';
import { automationOutputOriginId } from '../utils/persist-automation-event-output';

export interface BackfillAutomationOutputOriginIdOptions {
  db: DbClient;
  /** Rows scanned per batch (default 5000). */
  batchSize?: number;
  /** Milliseconds to sleep between batches to avoid hammering a live DB (default 200). */
  sleepMs?: number;
  /** Dry-run: count what WOULD be re-stamped without writing (default false). */
  execute?: boolean;
  log?: (msg: string) => void;
}

export interface BackfillAutomationOutputOriginIdReport {
  /** Rows whose origin_id was (or would be) re-stamped. */
  restamped: number;
  /** Rows inspected that already carried the derived origin_id. */
  alreadyCorrect: number;
  /** Number of batches processed. */
  batches: number;
}

interface CandidateRow {
  id: number;
  origin_id: string;
  automation_id: string | null;
  automation_output: string | null;
  idempotency_key: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recover the model-supplied source key from a stored idempotency key by
 * stripping the exact prefix the writer built it from. Reconstructing the
 * prefix (rather than splitting on `:key:`) keeps an output name that itself
 * contains `:key:` from truncating the recovered identity.
 */
function sourceKeyFrom(row: CandidateRow): string | null {
  if (!row.idempotency_key || !row.automation_id || !row.automation_output) return null;
  const prefix = `automation:${row.automation_id}:output:${row.automation_output}:key:`;
  if (!row.idempotency_key.startsWith(prefix)) return null;
  const sourceKey = row.idempotency_key.slice(prefix.length);
  return sourceKey.length > 0 ? sourceKey : null;
}

/**
 * Re-stamp positional Automation event-output origin_ids. Walks by ascending
 * event id so an interrupted run resumes cleanly.
 */
export async function backfillAutomationOutputOriginId(
  opts: BackfillAutomationOutputOriginIdOptions
): Promise<BackfillAutomationOutputOriginIdReport> {
  const sql = opts.db;
  const batchSize = opts.batchSize ?? 5000;
  const sleepMs = opts.sleepMs ?? 200;
  // A production backfill must not silently no-op (batchSize 0 makes every
  // batch empty → reports "done" with nothing re-stamped) or die on
  // LIMIT/negative sleep — reject bad knobs up front.
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize must be a positive integer (got ${String(opts.batchSize)})`);
  }
  if (!Number.isFinite(sleepMs) || sleepMs < 0) {
    throw new Error(`sleepMs must be a non-negative number (got ${String(opts.sleepMs)})`);
  }
  const execute = opts.execute ?? false;
  const log = opts.log ?? (() => {});

  let restamped = 0;
  let alreadyCorrect = 0;
  let batches = 0;
  let cursor = 0;

  for (;;) {
    const candidates = (await sql`
      SELECT id,
             origin_id,
             metadata->>'automation_id' AS automation_id,
             metadata->>'automation_output' AS automation_output,
             metadata->>'_lobu_idempotency_key' AS idempotency_key
      FROM events
      WHERE id > ${cursor}
        AND origin_id IS NOT NULL
        AND metadata ? 'automation_output'
        AND metadata ? '_lobu_idempotency_key'
      ORDER BY id ASC
      LIMIT ${batchSize}
    `) as unknown as CandidateRow[];

    if (candidates.length === 0) break;

    batches++;
    cursor = Number(candidates[candidates.length - 1]!.id);

    const ids: number[] = [];
    const originIds: string[] = [];
    for (const row of candidates) {
      const sourceKey = sourceKeyFrom(row);
      if (!sourceKey) continue;
      const derived = automationOutputOriginId(
        Number(row.automation_id),
        String(row.automation_output),
        sourceKey
      );
      if (derived === row.origin_id) {
        alreadyCorrect++;
        continue;
      }
      ids.push(Number(row.id));
      originIds.push(derived);
    }

    if (ids.length > 0) {
      if (execute) {
        // Re-checks `origin_id IS DISTINCT FROM` inside the UPDATE so a row the
        // fixed writer corrected between the SELECT and here is left alone.
        const updated = (await sql`
          UPDATE events e
          SET origin_id = v.new_origin_id
          FROM unnest(
            ${pgBigintArray(ids)}::bigint[],
            ${pgTextArray(originIds)}::text[]
          ) AS v(id, new_origin_id)
          WHERE e.id = v.id
            AND e.origin_id IS DISTINCT FROM v.new_origin_id
          RETURNING e.id
        `) as unknown as Array<{ id: number }>;
        restamped += updated.length;
      } else {
        restamped += ids.length;
      }
    }

    log(
      `batch ${batches}: inspected ${candidates.length}, ${execute ? 're-stamped' : 'would re-stamp'} ${ids.length} (cursor ${cursor})`
    );
    if (sleepMs > 0) await sleep(sleepMs);
  }

  return { restamped, alreadyCorrect, batches };
}
