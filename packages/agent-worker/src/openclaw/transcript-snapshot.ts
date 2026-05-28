/**
 * Mirrors session.jsonl to PG so multi-replica pods can hydrate.
 * Snapshot written on success only; hydrate reads latest completed row.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createLogger } from "@lobu/core";

const logger = createLogger("transcript-snapshot");

export type TerminalStatus = "completed" | "failed" | "timeout" | "cancelled";

interface TranscriptSnapshotOptions {
  /** Absolute path to the session.jsonl SessionManager reads/writes. */
  sessionFile: string;
  /** Gateway base URL (e.g. `http://127.0.0.1:8787/lobu`). */
  gatewayUrl: string;
  /** Worker JWT. The gateway pulls (org, agent, conv) from this token. */
  workerToken: string;
}

/**
 * Pull the latest `terminal_status='completed'` snapshot for this worker's
 * (org, agent, conv) and write the bytes to `sessionFile`. Must run BEFORE
 * SessionManager.open() so the rehydrated content is visible at open time.
 *
 * Returns `true` if a snapshot was found and written, `false` if no snapshot
 * exists yet (first turn). Throws on transport errors — caller decides
 * whether to fall back to a fresh session.
 */
export async function hydrateFromSnapshot(
  opts: TranscriptSnapshotOptions
): Promise<boolean> {
  const url = `${opts.gatewayUrl}/worker/transcript/snapshot`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${opts.workerToken}` },
    signal: AbortSignal.timeout(30_000),
  });

  // 404 = no completed snapshot for this (org, agent, conv). First turn or
  // every previous attempt failed/timed out. Caller should start fresh.
  if (res.status === 404) {
    return false;
  }
  if (!res.ok) {
    throw new Error(
      `transcript hydrate failed: ${res.status} ${res.statusText}`
    );
  }

  const body = await res.text();
  await fs.mkdir(path.dirname(opts.sessionFile), { recursive: true });
  // writeFile truncates atomically (open with O_TRUNC); no partial state
  // is visible to SessionManager.open() because that call runs after this
  // function resolves.
  await fs.writeFile(opts.sessionFile, body, "utf-8");
  // fsync so a pod crash between this return and SessionManager.open()
  // doesn't leave the file half-written. The cost is one extra disk flush
  // on every worker boot — acceptable.
  const handle = await fs.open(opts.sessionFile, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }

  logger.info(
    `Hydrated session file from snapshot: ${body.length} bytes → ${opts.sessionFile}`
  );
  return true;
}

/**
 * Read the session file in full and POST it to the gateway. Called once per
 * worker run at terminal time, from `OpenClawWorker.cleanup()`. The
 * `terminal_status` discriminator lets the hydrate path skip failed/timeout
 * snapshots so a dangling `tool_use` doesn't poison the next attempt.
 *
 * Failure to snapshot is logged but does NOT throw — there's nothing the
 * caller can do beyond what cleanup already does (the worker is exiting).
 * The next attempt will hydrate from the previous successful snapshot.
 */
export async function writeSnapshot(
  opts: TranscriptSnapshotOptions & {
    terminalStatus: TerminalStatus;
    /**
     * The runs.id this worker claimed. Sent in the POST body so the route
     * binds the snapshot to the correct run unambiguously; the route then
     * verifies the runId actually belongs to the JWT's (org, agent, conv)
     * tuple before INSERTing. Codex P1#1 on PR #865 — without this, the
     * route fell back to a "latest run for (org, agent, conv)" lookup
     * which raced with the next user message enqueuing a fresh run.
     */
    runId: number;
  }
): Promise<void> {
  // Hydrate filters `terminal_status='completed'` — failed/timeout/cancelled
  // snapshots are never used. POSTing them is pure network waste; the
  // route would store them but no future hydrate would pick them up.
  // Skip at the source so any caller (cleanup() today, future paths
  // tomorrow) stays out of the wasteful write. Codex round 2 quality
  // win C on PR #865.
  if (opts.terminalStatus !== "completed") {
    logger.debug(
      `Skipping snapshot POST: terminal_status='${opts.terminalStatus}' is never read by hydrate`
    );
    return;
  }

  let body: string;
  try {
    body = await fs.readFile(opts.sessionFile, "utf-8");
  } catch (err) {
    // No session file = nothing to snapshot. Common when the worker exits
    // before SessionManager.open() ran (early error path).
    const isMissing =
      err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isMissing) {
      logger.debug(`No session file at ${opts.sessionFile}; skipping snapshot`);
      return;
    }
    logger.warn(
      `Failed to read session file for snapshot: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (body.length === 0) {
    logger.debug("Empty session file; skipping snapshot");
    return;
  }

  const url = `${opts.gatewayUrl}/worker/transcript/snapshot`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.workerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        terminalStatus: opts.terminalStatus,
        snapshotJsonl: body,
        runId: opts.runId,
      }),
      // Snapshots can be large (633 KB max measured); 60s timeout covers
      // slow links + PG TOAST writes.
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      // 409 = UNIQUE (org, agent, conv, run_id) collision. Means another
      // pod (or a retry) already wrote this snapshot — benign, drop it.
      if (res.status === 409) {
        logger.info(
          `Snapshot for run already exists (status=${opts.terminalStatus}); skipping duplicate`
        );
        return;
      }
      logger.error(`Snapshot POST failed: ${res.status} ${res.statusText}`);
      return;
    }
    logger.info(
      `Wrote snapshot: ${body.length} bytes, status=${opts.terminalStatus}`
    );
  } catch (err) {
    logger.error(
      `Snapshot POST threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }
}

/**
 * Purge all snapshot rows for this worker's (org, agent, conv). Called
 * by the session-reset path so the next boot doesn't rehydrate the
 * conversation from Postgres after a `/new`. Idempotent — a 404 / empty
 * result is treated as success.
 *
 * Failures are logged but not thrown — reset is best-effort; if the
 * purge HTTP call fails the worst case is the next boot hydrates from
 * the previous transcript (the legacy file-mode behaviour). The local
 * session.jsonl unlink is the primary signal; this is the multi-replica
 * complement to it.
 */
export async function clearSnapshots(
  opts: Pick<TranscriptSnapshotOptions, "gatewayUrl" | "workerToken">
): Promise<void> {
  const url = `${opts.gatewayUrl}/worker/transcript/snapshot`;
  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${opts.workerToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn(
        `Snapshot DELETE failed: ${res.status} ${res.statusText} — next boot may rehydrate stale history`
      );
      return;
    }
    logger.info("Purged conversation snapshots for session reset");
  } catch (err) {
    logger.warn(
      `Snapshot DELETE threw: ${err instanceof Error ? err.message : String(err)} — next boot may rehydrate stale history`
    );
  }
}
