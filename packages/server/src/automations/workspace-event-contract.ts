/**
 * Wire contract and safety bounds for Automation-to-Automation event activation.
 * Kept dependency-light so queueing, reads, dispatch, and completion can share
 * the exact same limits without importing the activation runtime.
 */

export const MAX_WORKSPACE_EVENT_DEPTH = 8;
export const MAX_WORKSPACE_EVENT_FANOUT = 32;
export const MAX_COALESCED_AUTOMATION_EVENT_INPUTS = 25;
export const MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS = 256;

/**
 * Durable pointer passed between Automation runs. Event content stays in the
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
  causal_automation_ids: number[];
  depth: number;
}

export interface WorkspaceEventActivationTaskPayload {
  organizationId: string;
  eventId: number;
  rootEventIds: number[];
  causalAutomationIds: number[];
  depth: number;
}

export function isBoundedPositiveIntegerList(
  value: unknown,
  maxLength: number
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    value.every((item) => Number.isSafeInteger(item) && item > 0) &&
    new Set(value).size === value.length
  );
}

export function automationTriggerSignals<T = unknown>(payload: {
  trigger_signal?: T;
  trigger_signals?: unknown;
}): T[] {
  if (Array.isArray(payload.trigger_signals)) {
    return payload.trigger_signals as T[];
  }
  return payload.trigger_signal == null ? [] : [payload.trigger_signal];
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
    isBoundedPositiveIntegerList(
      signal.root_event_ids,
      MAX_COALESCED_AUTOMATION_EVENT_INPUTS
    ) &&
    signal.root_event_ids.length > 0 &&
    isBoundedPositiveIntegerList(
      signal.causal_automation_ids,
      MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS
    ) &&
    Number.isSafeInteger(signal.depth) &&
    Number(signal.depth) > 0
  );
}

/** Merge ancestry from coalesced upstream workspace-event deliveries. */
export function deriveWorkspaceEventCausality(
  signals: readonly unknown[],
  producerAutomationId: number
): { rootEventIds: number[]; causalAutomationIds: number[]; depth: number } {
  const workspaceSignals = signals.filter(isWorkspaceEventTriggerSignal);
  const rootEventIds: number[] = [];
  const causalAutomationIds: number[] = [];
  for (const signal of workspaceSignals) {
    for (const eventId of signal.root_event_ids) {
      if (!rootEventIds.includes(eventId)) rootEventIds.push(eventId);
    }
    for (const automationId of signal.causal_automation_ids) {
      if (!causalAutomationIds.includes(automationId))
        causalAutomationIds.push(automationId);
    }
  }
  // Matching already excludes an Automation present in the inherited path. Keep
  // this merge idempotent as a fail-safe for old or malformed queued signals:
  // dropping a completed producer window would be worse than preserving the
  // existing ancestry, which still prevents that Automation from re-entering.
  if (!causalAutomationIds.includes(producerAutomationId)) {
    causalAutomationIds.push(producerAutomationId);
  }
  if (causalAutomationIds.length > MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS) {
    throw new Error(
      `Workspace event causality exceeds ${MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS} distinct Automations`
    );
  }
  if (rootEventIds.length > MAX_COALESCED_AUTOMATION_EVENT_INPUTS) {
    throw new Error(
      `Workspace event causality exceeds ${MAX_COALESCED_AUTOMATION_EVENT_INPUTS} distinct roots`
    );
  }
  return {
    rootEventIds,
    causalAutomationIds,
    // Depth is the longest causal chain, not the number of distinct ancestors.
    // Coalescing two branches may increase the ancestor set without adding hops.
    depth:
      workspaceSignals.length > 0
        ? Math.max(...workspaceSignals.map((signal) => signal.depth)) + 1
        : 1,
  };
}
