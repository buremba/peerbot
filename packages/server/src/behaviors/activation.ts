import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import type { BehaviorEventTrigger } from "@lobu/core/contracts/tools/manage-behaviors";
import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import { runtimeConnectionIdToSlug } from "../lobu/stores/connections-projection";
import {
  type BehaviorEventRunQueued,
  createBehaviorEventRun,
} from "../runs/queue-service";
import logger from "../utils/logger";
import { dispatchPendingBehaviorRuns } from "../behaviors/automation";
import { matchingBehaviorTriggers } from "./event-trigger";

export interface MatchingBehaviorActivation {
  behaviorId: number;
  organizationId: string;
  agentId: string;
  deviceWorkerId: string | null;
  agentKind: string | null;
  model: string | null;
  instructions: string;
  /**
   * The Behavior's `min_cooldown_seconds`. Carried on the match so a caller can
   * skip the cooldown claim for Behaviors observed at the 0 default. Positive
   * values are re-read and consumed authoritatively under the per-Behavior lock
   * in `claimBehaviorCooldown`.
   */
  minCooldownSeconds: number;
  trigger: BehaviorEventTrigger;
}

export interface BehaviorActivationResult extends BehaviorEventRunQueued {
  behaviorId: number;
  trigger: BehaviorEventTrigger;
}

export interface BehaviorActivationPlan {
  signal: ConnectorTriggerSignal;
  replyTargets: MatchingBehaviorActivation[];
  backgroundTargets: MatchingBehaviorActivation[];
}

export interface RuntimeConnectionBehaviorLookup {
  connectionOrganizationId: string;
  runtimeConnectionId: string;
  signal: ConnectorTriggerSignal;
  crossOrganization?: boolean;
}

/**
 * Split matching Behaviors once, at the connector-neutral activation seam.
 * Reply targets stay with the chat transport so they retain thread history,
 * attachments, and live steering; every other target uses the durable run
 * queue. Connectors never implement this policy themselves.
 */
export function planBehaviorActivations(
  signal: ConnectorTriggerSignal,
  matches: MatchingBehaviorActivation[],
): BehaviorActivationPlan {
  const replyTargets: MatchingBehaviorActivation[] = [];
  const backgroundTargets: MatchingBehaviorActivation[] = [];
  for (const match of matches) {
    if (
      (match.trigger.execution ?? "turn") === "turn" &&
      (match.trigger.output ?? "silent") === "reply_to_source"
    ) {
      replyTargets.push(match);
    } else {
      backgroundTargets.push(match);
    }
  }
  return { signal, replyTargets, backgroundTargets };
}

/** Connector-neutral Behavior lookup used by webhooks, pollers, and chat. */
export async function findMatchingBehaviorActivations(
  organizationId: string,
  signal: ConnectorTriggerSignal,
  db: DbClient = getDb(),
  options?: { crossOrganization?: boolean },
): Promise<MatchingBehaviorActivation[]> {
  // Coarse GIN needle: kind + connector_key. When the signal carries a
  // connection_id, match that connection's triggers OR connector-wide triggers
  // (no connection_id on the trigger element). Without the connection arm the
  // org-scoped query pulled every Behavior for the connector across all
  // connections; the connection arm alone would drop connector-wide drafts.
  const baseNeedle = {
    kind: "event" as const,
    connector_key: signal.connector_key,
  };
  const organizationFilter = options?.crossOrganization
    ? db``
    : db`AND w.organization_id = ${organizationId}`;
  const connectionId = signal.connection_id;
  const triggerFilter =
    connectionId != null
      ? db`(
          w.triggers @> ${db.json([{ ...baseNeedle, connection_id: connectionId }])}::jsonb
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) t
            WHERE t->>'kind' = 'event'
              AND t->>'connector_key' = ${signal.connector_key}
              AND t->>'connection_id' IS NULL
          )
        )`
      : db`w.triggers @> ${db.json([baseNeedle])}::jsonb`;
  const rows = await db`
		SELECT w.id, w.organization_id, w.agent_id, w.device_worker_id::text AS device_worker_id,
		       w.agent_kind, w.triggers, w.execution_config->>'model' AS model,
		       w.min_cooldown_seconds, v.prompt
		FROM behaviors w
		JOIN behavior_versions v ON v.id = w.current_version_id
		WHERE w.status = 'active'
		  AND w.agent_id IS NOT NULL
		  AND ${triggerFilter}
		  ${organizationFilter}
		ORDER BY w.id ASC
	`;

  const matches: MatchingBehaviorActivation[] = [];
  for (const row of rows) {
    const triggers = Array.isArray(row.triggers)
      ? (row.triggers as BehaviorEventTrigger[])
      : [];
    // Multi-trigger Behaviors OR activations: any matching event trigger is
    // enough to run once. When several match the same signal, the first in
    // array order supplies execution/output/active_run (UI documents this).
    const [trigger] = matchingBehaviorTriggers(
      triggers.filter(
        (candidate): candidate is BehaviorEventTrigger =>
          candidate.kind === "event",
      ),
      signal,
    );
    if (!trigger) continue;
    matches.push({
      behaviorId: Number(row.id),
      organizationId: String(row.organization_id),
      agentId: String(row.agent_id),
      deviceWorkerId:
        typeof row.device_worker_id === "string" ? row.device_worker_id : null,
      agentKind: typeof row.agent_kind === "string" ? row.agent_kind : null,
      model: typeof row.model === "string" ? row.model : null,
      instructions: typeof row.prompt === "string" ? row.prompt : "",
      minCooldownSeconds: Number(row.min_cooldown_seconds ?? 0),
      trigger,
    });
  }
  return matches;
}

/**
 * Resolve a Chat SDK runtime id to the integer connection id used by Behavior
 * triggers, then perform the normal connector-neutral match. Runtime ids are
 * deliberately stable slugs (for example `slackinst-…`), not database ids.
 */
export async function planBehaviorActivationsForRuntimeConnection(
  args: RuntimeConnectionBehaviorLookup,
  db: DbClient = getDb(),
): Promise<BehaviorActivationPlan> {
  const connections = await db<{ id: number }>`
		SELECT id
		FROM connections
		WHERE organization_id = ${args.connectionOrganizationId}
		  AND slug = ${runtimeConnectionIdToSlug(args.runtimeConnectionId)}
		  AND connector_key = ${args.signal.connector_key}
		  AND deleted_at IS NULL
		LIMIT 1
  `;
  const connectionId = connections[0]?.id;
  if (connectionId == null) return planBehaviorActivations(args.signal, []);
  const signal = { ...args.signal, connection_id: Number(connectionId) };
  const matches = await findMatchingBehaviorActivations(
    args.connectionOrganizationId,
    signal,
    db,
    { crossOrganization: args.crossOrganization },
  );
  return planBehaviorActivations(signal, matches);
}

/**
 * Durably queue a precomputed set of Behavior activations. `db` must be an
 * open transaction when provided; when omitted, each run creation opens its
 * own so the per-Behavior lock and coalesce reads stay replica-safe.
 */
export async function queueBehaviorActivations(args: {
  matches: MatchingBehaviorActivation[];
  signal: ConnectorTriggerSignal;
  db?: DbClient;
}): Promise<BehaviorActivationResult[]> {
  if (args.matches.length === 0) return [];
  const results: BehaviorActivationResult[] = [];
  for (const match of args.matches) {
    const queued = await createBehaviorEventRun(
      {
        organizationId: match.organizationId,
        behaviorId: match.behaviorId,
        agentId: match.agentId,
        trigger: match.trigger,
        signal: args.signal,
        deviceWorkerId: match.deviceWorkerId,
        agentKind: match.agentKind,
      },
      args.db,
    );
    // A cooldown-suppressed activation produced no run, so it has nothing to
    // dispatch and must not reach `dispatchBehaviorRunsBestEffort`. The
    // decision itself is logged inside the claim.
    if (queued.disposition === "cooldown") continue;
    results.push({
      ...queued,
      behaviorId: match.behaviorId,
      trigger: match.trigger,
    });
  }

  return results;
}

/** Match a normalized signal and durably queue its Behavior runs. */
export async function activateBehaviorSignal(args: {
  organizationId: string;
  signal: ConnectorTriggerSignal;
  db?: DbClient;
}): Promise<BehaviorActivationResult[]> {
  const sql = args.db ?? getDb();
  const matches = await findMatchingBehaviorActivations(
    args.organizationId,
    args.signal,
    sql,
  );
  return queueBehaviorActivations({
    matches,
    signal: args.signal,
    db: args.db,
  });
}

/**
 * Start newly durable Behavior runs without failing an already-committed
 * connector delivery if the immediate dispatcher itself throws. The periodic
 * automation tick recovers any claim stranded by that failure.
 */
export async function dispatchBehaviorRunsBestEffort(
  results: Array<{ runId: number; status: string }>,
): Promise<void> {
  const runIds = results
    .filter((result) => result.status === "pending")
    .map((result) => result.runId);
  if (runIds.length === 0) return;
  try {
    await dispatchPendingBehaviorRuns({ runIds });
  } catch (error) {
    logger.error(
      { error, runIds },
      "Immediate Behavior dispatch threw; automation will recover stranded claims",
    );
  }
}
