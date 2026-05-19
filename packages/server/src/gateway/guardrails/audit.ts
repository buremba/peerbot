/**
 * Audit trail for guardrail trips. Every short-circuited stage writes one
 * `semantic_type='guardrail-trip'` row to `events` so operators can review
 * what was blocked, when, and why.
 *
 * `recordGuardrailTrip` returns a Promise that resolves once the insert
 * lands (or has been logged-and-swallowed on failure). Wired call sites
 * fire-and-forget by ignoring the return value; tests can `await` it. A
 * trip that we couldn't audit (e.g. missing organizationId after fallback)
 * is logged at warn so it shows up in the security log audit even when the
 * `events` row didn't make it.
 */

import { insertEvent } from "../../utils/insert-event";
import logger from "../../utils/logger";
import type { GuardrailStage } from "@lobu/core";

/**
 * Tracks in-flight `recordGuardrailTrip` calls so tests can flush all
 * pending audit writes without sleep-and-pray. Wired call sites use
 * `void recordGuardrailTrip(...)` and don't care about completion, but
 * the tracker still resolves on each insert so a single
 * `flushPendingGuardrailAudits()` await drains everything.
 */
const pendingAudits = new Set<Promise<void>>();

/**
 * Await all in-flight guardrail-audit inserts. For test code only — the
 * production call sites fire-and-forget so they don't block the user-facing
 * block message on a DB write. Resolves after the current set drains; new
 * trips that fire while we're awaiting are NOT included (call again).
 */
export async function flushPendingGuardrailAudits(): Promise<void> {
  // Snapshot the current set — Promise.allSettled handles concurrent
  // additions by simply not waiting on them.
  const snapshot = Array.from(pendingAudits);
  if (snapshot.length === 0) return;
  await Promise.allSettled(snapshot);
}

interface RecordGuardrailTripParams {
  organizationId: string | undefined;
  agentId: string;
  userId?: string;
  conversationId?: string;
  stage: GuardrailStage;
  guardrail: string;
  /**
   * Internal reason — written to the event row but never surfaced to the
   * blocked party for the pre-tool stage.
   */
  reason?: string;
  metadata?: unknown;
}

/**
 * Insert a `guardrail-trip` row. Returns a promise that resolves whether
 * the insert succeeds, throws, or is skipped (missing org id). Never
 * rejects — guardrail enforcement is the source of truth for the block,
 * the audit is best-effort but tests/operators can still observe failures
 * through the structured log emitted on the failure paths.
 */
export function recordGuardrailTrip(
  params: RecordGuardrailTripParams
): Promise<void> {
  const work = doRecordGuardrailTrip(params);
  pendingAudits.add(work);
  // Remove from the tracker regardless of success/failure so the set
  // doesn't grow unbounded.
  work.finally(() => pendingAudits.delete(work));
  return work;
}

async function doRecordGuardrailTrip(
  params: RecordGuardrailTripParams
): Promise<void> {
  // Without an organization id we can't write to `events` (org-scoped
  // schema). Log loudly — a trip that doesn't audit is a security log gap
  // and downstream callers must surface this on their own resolver paths.
  if (!params.organizationId) {
    logger.error(
      {
        agentId: params.agentId,
        guardrail: params.guardrail,
        stage: params.stage,
        reason: params.reason,
      },
      "[guardrail] trip not audited — no organizationId resolved (security log gap)"
    );
    return;
  }

  const originId = `guardrail_trip_${params.stage}_${params.guardrail}_${params.agentId}_${Date.now()}`;

  try {
    await insertEvent({
      entityIds: [],
      organizationId: params.organizationId,
      originId,
      title: `Guardrail "${params.guardrail}" tripped at ${params.stage}`,
      semanticType: "guardrail-trip",
      originType: `guardrail-${params.stage}`,
      metadata: {
        guardrail: params.guardrail,
        stage: params.stage,
        reason: params.reason ?? null,
        agent_id: params.agentId,
        user_id: params.userId ?? null,
        conversation_id: params.conversationId ?? null,
        ...(params.metadata !== undefined
          ? { guardrail_metadata: params.metadata }
          : {}),
      },
    });
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        guardrail: params.guardrail,
        stage: params.stage,
      },
      "[guardrail] failed to record trip event"
    );
  }
}
