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
  kind: 'event';
  source: 'workspace';
  event_id: number;
  event_type: string;
  delivery_id: string;
  occurred_at: string;
  root_event_ids: number[];
  causal_behavior_ids: number[];
  depth: number;
}

export interface WorkspaceEventActivationTaskPayload {
  organizationId: string;
  eventId: number;
  rootEventIds: number[];
  causalBehaviorIds: number[];
  depth: number;
}

export function isWorkspaceEventTriggerSignal(
  value: unknown
): value is WorkspaceEventTriggerSignal {
  if (!value || typeof value !== 'object') return false;
  const signal = value as Partial<WorkspaceEventTriggerSignal>;
  return (
    signal.kind === 'event' &&
    signal.source === 'workspace' &&
    Number.isSafeInteger(signal.event_id) &&
    Number(signal.event_id) > 0 &&
    typeof signal.event_type === 'string' &&
    typeof signal.delivery_id === 'string' &&
    Array.isArray(signal.root_event_ids) &&
    signal.root_event_ids.length > 0 &&
    signal.root_event_ids.length <= MAX_COALESCED_BEHAVIOR_EVENT_INPUTS &&
    signal.root_event_ids.every(
      (eventId) => Number.isSafeInteger(eventId) && eventId > 0
    ) &&
    new Set(signal.root_event_ids).size === signal.root_event_ids.length &&
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
): { rootEventIds: number[]; causalBehaviorIds: number[]; depth: number } {
  const workspaceSignals = signals.filter(isWorkspaceEventTriggerSignal);
  const rootEventIds: number[] = [];
  const causalBehaviorIds: number[] = [];
  for (const signal of workspaceSignals) {
    for (const eventId of signal.root_event_ids) {
      if (!rootEventIds.includes(eventId)) rootEventIds.push(eventId);
    }
    for (const behaviorId of signal.causal_behavior_ids) {
      if (!causalBehaviorIds.includes(behaviorId))
        causalBehaviorIds.push(behaviorId);
    }
  }
  // Matching already excludes a Behavior present in the inherited path. Keep
  // this merge idempotent as a fail-safe for old or malformed queued signals:
  // dropping a completed producer window would be worse than preserving the
  // existing ancestry, which still prevents that Behavior from re-entering.
  if (!causalBehaviorIds.includes(producerBehaviorId)) {
    causalBehaviorIds.push(producerBehaviorId);
  }
  if (causalBehaviorIds.length > MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS) {
    throw new Error(
      `Workspace event causality exceeds ${MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS} distinct Behaviors`
    );
  }
  if (rootEventIds.length > MAX_COALESCED_BEHAVIOR_EVENT_INPUTS) {
    throw new Error(
      `Workspace event causality exceeds ${MAX_COALESCED_BEHAVIOR_EVENT_INPUTS} distinct roots`
    );
  }
  return {
    rootEventIds,
    causalBehaviorIds,
    // Depth is the longest causal chain, not the number of distinct ancestors.
    // Coalescing two branches may increase the ancestor set without adding hops.
    depth:
      workspaceSignals.length > 0
        ? Math.max(...workspaceSignals.map((signal) => signal.depth)) + 1
        : 1,
  };
}
