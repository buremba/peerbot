/**
 * Wire contract and safety bounds for Behavior-to-Behavior event activation.
 * Kept dependency-light so queueing, reads, dispatch, and completion can share
 * the exact same limits without importing the activation runtime.
 */

export const MAX_WORKSPACE_EVENT_DEPTH = 8;
export const MAX_WORKSPACE_EVENT_FANOUT = 32;
export const MAX_COALESCED_BEHAVIOR_EVENT_INPUTS = 25;
export const MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS = 256;

/**
 * Durable pointer passed between Behavior runs. Event content stays in the
 * append-only event store; this signal carries only delivery/correlation data.
 */
export interface WorkspaceEventTriggerSignal {
  kind: 'workspace_event';
  event_id: number;
  event_type: string;
  delivery_id: string;
  occurred_at: string;
  root_event_id: number;
  causal_behavior_ids: number[];
  depth: number;
}

export interface WorkspaceEventActivationTaskPayload {
  organizationId: string;
  eventId: number;
  rootEventId: number;
  causalBehaviorIds: number[];
  depth: number;
}

export function isWorkspaceEventTriggerSignal(
  value: unknown
): value is WorkspaceEventTriggerSignal {
  if (!value || typeof value !== 'object') return false;
  const signal = value as Partial<WorkspaceEventTriggerSignal>;
  return (
    signal.kind === 'workspace_event' &&
    Number.isSafeInteger(signal.event_id) &&
    Number(signal.event_id) > 0 &&
    typeof signal.event_type === 'string' &&
    typeof signal.delivery_id === 'string' &&
    Number.isSafeInteger(signal.root_event_id) &&
    Number(signal.root_event_id) > 0 &&
    Array.isArray(signal.causal_behavior_ids) &&
    signal.causal_behavior_ids.length <=
      MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS &&
    signal.causal_behavior_ids.every(
      (behaviorId) => Number.isSafeInteger(behaviorId) && behaviorId > 0
    ) &&
    new Set(signal.causal_behavior_ids).size ===
      signal.causal_behavior_ids.length &&
    Number.isSafeInteger(signal.depth) &&
    Number(signal.depth) > 0
  );
}

/** Merge ancestry from coalesced upstream workspace-event deliveries. */
export function deriveWorkspaceEventCausality(
  signals: readonly unknown[],
  producerBehaviorId: number
): { rootEventId: number | null; causalBehaviorIds: number[]; depth: number } {
  const workspaceSignals = signals.filter(isWorkspaceEventTriggerSignal);
  const causalBehaviorIds: number[] = [];
  for (const signal of workspaceSignals) {
    for (const behaviorId of signal.causal_behavior_ids) {
      if (!causalBehaviorIds.includes(behaviorId))
        causalBehaviorIds.push(behaviorId);
    }
  }
  if (!causalBehaviorIds.includes(producerBehaviorId)) {
    causalBehaviorIds.push(producerBehaviorId);
  }
  if (causalBehaviorIds.length > MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS) {
    throw new Error(
      `Workspace event causality exceeds ${MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS} distinct Behaviors`
    );
  }
  return {
    rootEventId: workspaceSignals[0]?.root_event_id ?? null,
    causalBehaviorIds,
    // Depth is the longest causal chain, not the number of distinct ancestors.
    // Coalescing two branches may increase the ancestor set without adding hops.
    depth:
      workspaceSignals.length > 0
        ? Math.max(...workspaceSignals.map((signal) => signal.depth)) + 1
        : 1,
  };
}
