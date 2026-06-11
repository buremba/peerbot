/**
 * Shared stale-run reaping core.
 *
 * Two reapers mark in-progress `runs` rows (`claimed`/`running`) as `timeout`
 * when their liveness signal lapses:
 *
 *   - the connector-lane reaper (scheduled/check-stalled-executions.ts) —
 *     sync/action/embed_backfill/auth, single 120s threshold
 *   - the watcher sweep (watchers/automation.ts) — 3min heartbeat-stale fast
 *     path + 2h coarse TTL for runs that never heartbeated
 *
 * Both share one predicate shape: a run with a live heartbeat signal is
 * judged on `last_heartbeat_at` against the heartbeat threshold; a run
 * without one is judged on `COALESCE(claimed_at, created_at)` against the
 * coarse threshold. What differs per caller is which rows count as
 * "heartbeating" and the two thresholds — captured in {@link StaleRunSweepSpec}.
 *
 * `buildStaleRunWhereSql` returns the WHERE fragment so the connector reaper
 * can keep its atomic timeout-plus-retry CTE (the UPDATE must stay inside
 * that single statement); `markStaleRunsAsTimeout` runs the plain UPDATE for
 * callers without a retry lane. The fragments are inlined via `sql.unsafe`,
 * so every input is validated against a strict literal pattern first.
 */

import { PG_INTERVAL_PATTERN } from '../config/intervals';
import type { DbClient } from '../db/client';

export interface StaleRunSweepSpec {
  /** `runs.run_type` values covered by this sweep. */
  runTypes: readonly string[];
  /**
   * Which rows count as "heartbeating":
   *  - 'any-heartbeat': any non-NULL `last_heartbeat_at` (connector lanes —
   *    the claim doesn't stamp a heartbeat, so presence means the executor
   *    beat at least once).
   *  - 'beat-after-claim': only rows whose `last_heartbeat_at` advanced past
   *    `claimed_at` (watcher lane — the claim seeds
   *    `last_heartbeat_at = claimed_at`, so equality means "never beat" and
   *    a non-heartbeating client falls through to the coarse path).
   */
  heartbeatSemantics: 'any-heartbeat' | 'beat-after-claim';
  /** Postgres interval literal (e.g. '3 minutes'). Heartbeating rows whose
   *  last beat is older than this are reaped. */
  heartbeatStaleInterval: string;
  /** Postgres interval literal. Non-heartbeating rows whose
   *  `COALESCE(claimed_at, created_at)` is older than this are reaped. */
  coarseStaleInterval: string;
}

const RUN_TYPE_PATTERN = /^[a-z_]+$/;

/** Validate + quote a `<n> <unit>` literal as a SQL interval expression. */
function intervalSql(literal: string): string {
  if (!PG_INTERVAL_PATTERN.test(literal)) {
    throw new Error(`Invalid Postgres interval literal: ${JSON.stringify(literal)}`);
  }
  return `interval '${literal}'`;
}

function runTypeListSql(runTypes: readonly string[]): string {
  if (runTypes.length === 0) {
    throw new Error('StaleRunSweepSpec.runTypes must not be empty');
  }
  return runTypes
    .map((runType) => {
      if (!RUN_TYPE_PATTERN.test(runType)) {
        throw new Error(`Invalid run_type literal: ${JSON.stringify(runType)}`);
      }
      return `'${runType}'`;
    })
    .join(', ');
}

/** SQL boolean expr: this row has a live heartbeat signal per the spec. */
export function hasHeartbeatSql(semantics: StaleRunSweepSpec['heartbeatSemantics']): string {
  return semantics === 'beat-after-claim'
    ? `(last_heartbeat_at IS NOT NULL
       AND claimed_at IS NOT NULL
       AND last_heartbeat_at > claimed_at)`
    : 'last_heartbeat_at IS NOT NULL';
}

/** Exact complement of {@link hasHeartbeatSql}, spelled out (De Morgan) so
 *  the SQL is two-valued even when `claimed_at` / `last_heartbeat_at` are
 *  NULL. */
function neverHeartbeatedSql(semantics: StaleRunSweepSpec['heartbeatSemantics']): string {
  return semantics === 'beat-after-claim'
    ? `(last_heartbeat_at IS NULL
       OR claimed_at IS NULL
       OR last_heartbeat_at <= claimed_at)`
    : 'last_heartbeat_at IS NULL';
}

/**
 * WHERE fragment selecting the stale in-progress rows for this spec.
 * Column references are unqualified — embed in an `UPDATE runs` (or
 * `UPDATE public.runs`) without an alias.
 */
export function buildStaleRunWhereSql(spec: StaleRunSweepSpec): string {
  return `
    run_type IN (${runTypeListSql(spec.runTypes)})
    AND status IN ('claimed', 'running')
    AND (
      -- Fast path: the executor was heartbeating, then went silent.
      (${hasHeartbeatSql(spec.heartbeatSemantics)}
       AND last_heartbeat_at
           < current_timestamp - ${intervalSql(spec.heartbeatStaleInterval)})
      OR
      -- Coarse backstop: ONLY for runs without a live heartbeat signal, so a
      -- heartbeating run that legitimately outlives the coarse TTL (fresh
      -- heartbeat) is never killed here.
      (${neverHeartbeatedSql(spec.heartbeatSemantics)}
       AND COALESCE(claimed_at, created_at)
           < current_timestamp - ${intervalSql(spec.coarseStaleInterval)})
    )
  `;
}

/**
 * Mark every stale in-progress run matched by the spec as `timeout` in one
 * UPDATE, stamping the path-appropriate error message. Returns the number of
 * rows transitioned.
 */
export async function markStaleRunsAsTimeout(
  sql: DbClient,
  spec: StaleRunSweepSpec & {
    /** error_message for rows reaped via the heartbeat-stale fast path. */
    heartbeatErrorMessage: string;
    /** error_message for rows reaped via the coarse TTL backstop. */
    coarseErrorMessage: string;
  }
): Promise<number> {
  const result = await sql.unsafe(
    `UPDATE runs
     SET status = 'timeout',
         completed_at = current_timestamp,
         error_message = CASE
           WHEN ${hasHeartbeatSql(spec.heartbeatSemantics)} THEN $1
           ELSE $2
         END
     WHERE ${buildStaleRunWhereSql(spec)}`,
    [spec.heartbeatErrorMessage, spec.coarseErrorMessage]
  );
  return Number(result.count ?? 0);
}
