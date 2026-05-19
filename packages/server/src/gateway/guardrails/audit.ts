/**
 * Audit trail for guardrail trips. Every short-circuited stage logs one
 * `semantic_type='guardrail-trip'` row to `events` so operators can review
 * what was blocked, when, and why. Fire-and-forget — guardrail enforcement
 * must not depend on the audit write succeeding.
 */

import { insertEvent } from "../../utils/insert-event";
import logger from "../../utils/logger";
import type { GuardrailStage } from "@lobu/core";

interface RecordGuardrailTripParams {
  organizationId: string | undefined;
  agentId: string;
  userId?: string;
  conversationId?: string;
  stage: GuardrailStage;
  guardrail: string;
  /** Internal reason — written to the event row but never surfaced to the
   *  blocked party for the pre-tool stage. */
  reason?: string;
  metadata?: unknown;
}

export function recordGuardrailTrip(params: RecordGuardrailTripParams): void {
  // We require an organizationId to write to the events table — the schema
  // is org-scoped. If we don't have one (e.g. an unbound auth path), log
  // and skip; the enforcement decision has already taken effect.
  if (!params.organizationId) {
    logger.warn(
      {
        agentId: params.agentId,
        guardrail: params.guardrail,
        stage: params.stage,
      },
      "[guardrail] trip not audited — no organizationId in context"
    );
    return;
  }

  const originId = `guardrail_trip_${params.stage}_${params.guardrail}_${params.agentId}_${Date.now()}`;

  insertEvent({
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
  }).catch((err) => {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        guardrail: params.guardrail,
        stage: params.stage,
      },
      "[guardrail] failed to record trip event"
    );
  });
}
