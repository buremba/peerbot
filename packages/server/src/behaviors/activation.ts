import type { ConnectorTriggerSignal } from "@lobu/connector-sdk";
import type { BehaviorEventTrigger } from "@lobu/core/contracts/tools/manage-behaviors";
import type { DbClient } from "../db/client";
import { getDb } from "../db/client";
import { runtimeConnectionIdToSlug } from "../lobu/stores/connections-projection";
import {
  type BehaviorEventRunResult,
  createBehaviorEventRun,
} from "../runs/queue-service";
import logger from "../utils/logger";
import { dispatchPendingWatcherRuns } from "../watchers/automation";
import { matchingBehaviorTriggers } from "./event-trigger";

export interface MatchingBehaviorActivation {
  behaviorId: number;
  organizationId: string;
  agentId: string;
  deviceWorkerId: string | null;
  agentKind: string | null;
  model: string | null;
  instructions: string;
  trigger: BehaviorEventTrigger;
}

export interface BehaviorActivationResult extends BehaviorEventRunResult {
  behaviorId: number;
  trigger: BehaviorEventTrigger;
}

export interface RuntimeConnectionBehaviorLookup {
  connectionOrganizationId: string;
  runtimeConnectionId: string;
  signal: ConnectorTriggerSignal;
  crossOrganization?: boolean;
}

/** Connector-neutral Behavior lookup used by webhooks, pollers, and chat. */
export async function findMatchingBehaviorActivations(
  organizationId: string,
  signal: ConnectorTriggerSignal,
  db: DbClient = getDb(),
  options?: { crossOrganization?: boolean },
): Promise<MatchingBehaviorActivation[]> {
  const coarseNeedle = [
    {
      kind: "event",
      connector_key: signal.connector_key,
      ...(options?.crossOrganization
        ? { connection_id: signal.connection_id }
        : {}),
    },
  ];
  const organizationFilter = options?.crossOrganization
    ? db``
    : db`AND w.organization_id = ${organizationId}`;
  const rows = await db`
		SELECT w.id, w.organization_id, w.agent_id, w.device_worker_id::text AS device_worker_id,
		       w.agent_kind, w.triggers, w.execution_config->>'model' AS model,
		       v.prompt
		FROM watchers w
		JOIN watcher_versions v ON v.id = w.current_version_id
		WHERE w.status = 'active'
		  AND w.agent_id IS NOT NULL
		  AND w.triggers @> ${db.json(coarseNeedle)}::jsonb
		  ${organizationFilter}
		ORDER BY w.id ASC
	`;

  const matches: MatchingBehaviorActivation[] = [];
  for (const row of rows) {
    const triggers = Array.isArray(row.triggers)
      ? (row.triggers as BehaviorEventTrigger[])
      : [];
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
export async function findMatchingBehaviorActivationsForRuntimeConnection(
  args: RuntimeConnectionBehaviorLookup,
  db: DbClient = getDb(),
): Promise<MatchingBehaviorActivation[]> {
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
  if (connectionId == null) return [];
  return findMatchingBehaviorActivations(
    args.connectionOrganizationId,
    { ...args.signal, connection_id: Number(connectionId) },
    db,
    { crossOrganization: args.crossOrganization },
  );
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
  const results: BehaviorActivationResult[] = [];
  for (const match of matches) {
    const queued = await createBehaviorEventRun(
      {
        organizationId: match.organizationId,
        watcherId: match.behaviorId,
        agentId: match.agentId,
        trigger: match.trigger,
        signal: args.signal,
        deviceWorkerId: match.deviceWorkerId,
        agentKind: match.agentKind,
      },
      sql,
    );
    results.push({
      ...queued,
      behaviorId: match.behaviorId,
      trigger: match.trigger,
    });
  }

  return results;
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
    await dispatchPendingWatcherRuns({ runIds });
  } catch (error) {
    logger.error(
      { error, runIds },
      "Immediate Behavior dispatch threw; automation will recover stranded claims",
    );
  }
}
