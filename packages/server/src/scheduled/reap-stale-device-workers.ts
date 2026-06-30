/**
 * Stale device-worker reaper.
 *
 * Safety net for `device_workers` orphaning. The primary fix is identity reuse
 * at mint-child-token (the Mac bridge forwards the extension's existing
 * worker_id so native re-pairs don't mint fresh ones) — but a row can still be
 * genuinely abandoned when the browser-profile install that owned it is gone:
 * extension uninstall, "clear extension data", or a second machine no longer in
 * use. Those rows have no live credential anywhere (the cred lived in the same
 * `chrome.storage.local` that got wiped), so the row is dead and only clutters
 * the Devices page.
 *
 * This reaper deletes device_workers rows that are BOTH stale (unseen far
 * beyond the 7-day freshness window) AND have no bindings — no pinned
 * connections, watchers, or auth-profiles — so it never disturbs a device a
 * connection or watcher still depends on. The no-binding predicate is re-checked
 * inside the DELETE so a binding created between the candidate scan and the
 * delete keeps the row alive. Child PATs bound to the reaped worker_ids are
 * revoked on the way out.
 *
 * Single-claimant per tick via the runs-queue (like the other scheduled jobs);
 * pure Postgres, so it's correct under N>1 app replicas.
 */

import { getDb, pgTextArray } from '../db/client';
import logger from '../utils/logger';

export async function reapStaleDeviceWorkers(): Promise<{
  scanned: number;
  reaped: number;
}> {
  const sql = getDb();

  // 1. Candidate scan: stale + no bindings. Read-only; the authoritative
  //    no-binding check is repeated inside the DELETE below. 30 days is well
  //    beyond the 7-day freshness window reconcileDeviceCapabilities uses, so a
  //    temporarily offline device (laptop closed, vacation) is never reaped.
  const candidates = (await sql`
    SELECT id, worker_id FROM device_workers
    WHERE last_seen_at < now() - interval '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM connections c
        WHERE c.device_worker_id = device_workers.id AND c.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM watchers w WHERE w.device_worker_id = device_workers.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth_profiles ap WHERE ap.device_worker_id = device_workers.id
      )
    LIMIT 500
  `) as unknown as Array<{ id: string; worker_id: string }>;

  if (candidates.length === 0) {
    return { scanned: 0, reaped: 0 };
  }

  const ids = candidates.map((c) => c.id);

  // 2-3. Authoritative delete + PAT revocation in ONE transaction. Re-check
  //    every no-binding predicate inside the DELETE so a binding created since
  //    the scan keeps its row; RETURNING the worker_ids actually deleted scopes
  //    PAT revocation to exactly the rows we removed. Doing both inside a single
  //    transaction avoids the inter-statement window where a concurrent poll
  //    could re-create a just-deleted row (poll upserts device_workers) and then
  //    have its token revoked afterward — here the row is gone and the PAT is
  //    revoked at the same commit, so there's no post-delete/pre-revoke gap.
  //
  //    A dangling PAT on a reaped worker_id CAN still poll if a device holding
  //    it comes back online — poll re-creates the device_workers row — so
  //    revoking ensures the row stays gone rather than resurrecting. Not a
  //    correctness hazard, just keeps the fleet honest.
  //
  //    `id::text = ANY(pgTextArray(...)::text[])` instead of `::uuid[]`: a
  //    pgTextArray literal passed through a `::uuid[]` cast trips a postgres
  //    "malformed array literal" under postgres.js's extended-protocol path
  //    (see the note in worker-api/device-reconcile.ts). UUIDs are canonical
  //    lowercase, so text equality matches the uuid form 1:1.
  const deleted = await sql.begin(async (tx) => {
    const rows = (await tx`
      DELETE FROM device_workers
      WHERE id::text = ANY(${pgTextArray(ids)}::text[])
        AND last_seen_at < now() - interval '30 days'
        AND NOT EXISTS (
          SELECT 1 FROM connections c
          WHERE c.device_worker_id = device_workers.id AND c.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM watchers w WHERE w.device_worker_id = device_workers.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM auth_profiles ap WHERE ap.device_worker_id = device_workers.id
        )
      RETURNING worker_id
    `) as unknown as Array<{ worker_id: string }>;

    const workerIds = rows.map((r) => r.worker_id);
    if (workerIds.length > 0) {
      await tx`
        UPDATE personal_access_tokens
        SET revoked_at = NOW(), updated_at = NOW()
        WHERE worker_id = ANY(${pgTextArray(workerIds)}::text[])
          AND revoked_at IS NULL
      `;
    }
    return rows;
  });

  return { scanned: candidates.length, reaped: deleted.length };
}

/** Scheduled-task wrapper: run the reaper and log a summary. */
export async function runReapStaleDeviceWorkers(): Promise<void> {
  const result = await reapStaleDeviceWorkers();
  if (result.reaped > 0) {
    logger.info({ ...result }, '[task] reap-stale-device-workers completed');
  }
}
