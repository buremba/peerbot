/**
 * Worker-facing snapshot endpoints for OpenClaw transcripts.
 *
 * Mounted at `/worker/transcript/snapshot`:
 *   GET  → return the latest `terminal_status='completed'` snapshot for
 *          this worker's (org, agent, conversation), as raw JSONL bytes.
 *          404 when no completed snapshot exists.
 *   POST → write a snapshot row for the current run.
 *
 * Authentication is the existing worker JWT (Bearer token). All routing
 * inputs (org, agent, conv) come from the verified token — the request
 * body controls only the payload + terminal_status. Workers cannot
 * impersonate another conversation.
 *
 * Why these are new endpoints (vs. modifying `agent-history.ts` only): the
 * worker is sandboxed and has no `DATABASE_URL`. The snapshot write path
 * must go through an authenticated gateway hop. The hydrate path could
 * have lived inside agent-history's existing fallback logic, but that
 * route is settings-cookie-authenticated (admin UI), not worker-JWT —
 * keeping the worker-side reader on the same `/worker/*` mount keeps the
 * auth model consistent.
 */

import type { WorkerTokenData } from "@lobu/core";
import { createLogger, verifyWorkerToken } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";

const logger = createLogger("worker-transcript");

/**
 * Soft cap for inbound snapshots. Production p99 is 1.3 KB; the largest row
 * we've seen across 2050 real session.jsonl entries is 633 KB. 4 MB leaves
 * comfortable headroom for one or two future LLM context-window expansions
 * before we have to introduce R2 spill.
 */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

interface SnapshotRow {
  snapshot_jsonl: string;
}

function authenticate(c: Context): WorkerTokenData | null {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7);
  return verifyWorkerToken(token);
}

/**
 * Resolve the run_id this worker should write a snapshot for. The worker
 * doesn't know its run id directly — it has `(org, agent, conv)` from the
 * JWT and the runs table records the most recent `claimed|running` row
 * for that conversation in `action_input.conversationId`. We pick the
 * latest such row.
 *
 * Returns null if no in-flight run is found. That can happen when:
 *   - the run was already reaped (heartbeat timeout)
 *   - the snapshot fires after the run row moved to `completed` and the
 *     reaper has since pruned it
 * In both cases dropping the snapshot is correct — the run is no longer
 * recoverable so persisting its transcript wouldn't help.
 */
async function resolveLatestRunId(
  organizationId: string,
  agentId: string,
  conversationId: string
): Promise<number | null> {
  const sql = getDb();
  const rows = await sql<{ id: number }>`
    SELECT id FROM public.runs
    WHERE organization_id = ${organizationId}
      AND run_type IN ('chat_message', 'agent_run', 'schedule', 'task')
      AND (action_input ->> 'agentId') = ${agentId}
      AND (action_input ->> 'conversationId') = ${conversationId}
    ORDER BY id DESC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export function createTranscriptRoutes(): Hono {
  const app = new Hono();

  /** GET — hydrate latest completed snapshot for this (org, agent, conv). */
  app.get("/snapshot", async (c) => {
    const token = authenticate(c);
    if (!token) return c.json({ error: "Invalid token" }, 401);

    const { organizationId, agentId, conversationId } = token;
    if (!organizationId || !agentId || !conversationId) {
      // organizationId is optional on the WorkerTokenData type but
      // production tokens always set it. Reject defensively rather than
      // falling back to NULL and matching every tenant's snapshot.
      return c.json({ error: "Token missing required scope" }, 400);
    }

    const sql = getDb();
    const rows = await sql<SnapshotRow>`
      SELECT snapshot_jsonl
      FROM public.agent_transcript_snapshot
      WHERE organization_id = ${organizationId}
        AND agent_id = ${agentId}
        AND conversation_id = ${conversationId}
        AND terminal_status = 'completed'
      ORDER BY run_id DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return c.json({ error: "No snapshot found" }, 404);
    }
    return c.body(row.snapshot_jsonl, 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
    });
  });

  /** POST — write a snapshot for the worker's current run. */
  app.post("/snapshot", async (c) => {
    const token = authenticate(c);
    if (!token) return c.json({ error: "Invalid token" }, 401);

    const { organizationId, agentId, conversationId } = token;
    if (!organizationId || !agentId || !conversationId) {
      return c.json({ error: "Token missing required scope" }, 400);
    }

    let body: { terminalStatus?: string; snapshotJsonl?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const terminalStatus = body.terminalStatus;
    const snapshotJsonl = body.snapshotJsonl;
    if (
      terminalStatus !== "completed" &&
      terminalStatus !== "failed" &&
      terminalStatus !== "timeout" &&
      terminalStatus !== "cancelled"
    ) {
      return c.json({ error: "Invalid terminalStatus" }, 400);
    }
    if (typeof snapshotJsonl !== "string" || snapshotJsonl.length === 0) {
      return c.json({ error: "Missing snapshotJsonl" }, 400);
    }
    const byteSize = Buffer.byteLength(snapshotJsonl, "utf-8");
    if (byteSize > MAX_SNAPSHOT_BYTES) {
      logger.warn(
        `Rejecting oversize snapshot (${byteSize} > ${MAX_SNAPSHOT_BYTES} bytes) for (${organizationId}, ${agentId}, ${conversationId})`
      );
      return c.json({ error: "Snapshot too large" }, 413);
    }

    const runId = await resolveLatestRunId(
      organizationId,
      agentId,
      conversationId
    );
    if (runId === null) {
      logger.warn(
        `No in-flight run for (${organizationId}, ${agentId}, ${conversationId}); dropping snapshot`
      );
      return c.json({ error: "No run to attach snapshot to" }, 404);
    }

    const sql = getDb();
    try {
      // ON CONFLICT keeps the existing row. Two pods racing under a partially-
      // broken advisory lock (e.g. lock dropped mid-flight) would both POST;
      // first writer wins, second sees the unique-violation and 409s. The
      // worker treats 409 as benign and returns silently.
      const inserted = await sql<{ id: number }>`
        INSERT INTO public.agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id,
           snapshot_jsonl, byte_size, terminal_status)
        VALUES
          (${organizationId}, ${agentId}, ${conversationId}, ${runId},
           ${snapshotJsonl}, ${byteSize}, ${terminalStatus})
        ON CONFLICT (organization_id, agent_id, conversation_id, run_id)
          DO NOTHING
        RETURNING id
      `;
      if (inserted.length === 0) {
        // ON CONFLICT DO NOTHING returned no row → snapshot already exists.
        return c.json({ error: "Snapshot already exists for run" }, 409);
      }
      logger.info(
        `Wrote snapshot id=${inserted[0]!.id} run_id=${runId} byte_size=${byteSize} status=${terminalStatus}`
      );
      return c.json({ id: inserted[0]!.id });
    } catch (err) {
      logger.error(
        `Snapshot INSERT failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return app;
}
