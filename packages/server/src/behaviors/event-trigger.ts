import type {
  BehaviorEventTrigger,
} from '@lobu/core/contracts/tools/manage-behaviors';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';

/**
 * Connector-neutral signal after webhook/chat authentication and normalization.
 * Provider drivers own those boundaries; the Behavior only sees this small
 * value plus a reference to the already-durable source record.
 */
function matchesTrigger(
  trigger: BehaviorEventTrigger,
  signal: ConnectorTriggerSignal,
  options?: MatchingBehaviorTriggerOptions,
): boolean {
  if (trigger.connector_key !== signal.connector_key) return false;
  if (signal.unchanged && trigger.skip_if_unchanged !== false) return false;
  if (
    trigger.connection_id !== undefined &&
    trigger.connection_id !== signal.connection_id &&
    // Workspace-identity aliases (#2148): a Slack Grid workspace may be served
    // by an `E…`-keyed org-wide row AND a `T…`-keyed per-workspace row at
    // once. A trigger anchored on either sibling connection id still belongs
    // to this workspace's messages. Identity-first with connection-id
    // fallback: the exact-id check above stays authoritative when no alias
    // set is supplied, so non-chat callers are byte-for-byte unchanged.
    !options?.connectionIdAliases?.includes(trigger.connection_id)
  ) {
    return false;
  }
  if (!trigger.event_types.includes(signal.event_type)) return false;

  const normalizedFields: Record<
    string,
    string | number | boolean | null | undefined
  > = {
    ...signal.attributes,
    resource_type: signal.resource_type,
    resource_ref: signal.resource_ref,
  };
  return Object.entries(trigger.match ?? {}).every(([key, expected]) => {
    // team_id is system-written delivery metadata (chat-link creation, Grid
    // self-heal, migration backfill), never a user-facing catalog filter. The
    // legacy binding lookup routed by channel alone; enforcing team equality
    // here silently drops Slack Connect messages (author's workspace id) and
    // payloads that omit team. channel/connection identity still gates.
    if (key === 'team_id') return true;
    // mention_only:false is an unchecked UI checkbox ("no filter"), not
    // "only non-mentions". Treat it as absent so already-stored rows still
    // match every message; writes strip the key in normalizeBehaviorTriggers.
    if (key === 'mention_only' && expected === false) return true;
    return normalizedFields[key] === expected;
  });
}

/**
 * Options for {@link matchingBehaviorTriggers}. `connectionIdAliases` is the
 * routed connection's same-workspace sibling ids (see
 * `lobu/stores/chat-workspace-identity`); a trigger anchored on any of them
 * matches in addition to the signal's own `connection_id`.
 */
export interface MatchingBehaviorTriggerOptions {
  connectionIdAliases?: readonly number[];
}

/** Select event activations independently from a Behavior's context sources. */
export function matchingBehaviorTriggers(
  triggers: BehaviorEventTrigger[],
  signal: ConnectorTriggerSignal,
  options?: MatchingBehaviorTriggerOptions,
): BehaviorEventTrigger[] {
  return triggers.filter((trigger) => matchesTrigger(trigger, signal, options));
}
