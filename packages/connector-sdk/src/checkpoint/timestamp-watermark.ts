import type { EventEnvelope } from '../connector-types.js';
import { applyLookbackCutoff } from './lookback.js';

function maxOccurredAt(events: EventEnvelope[]): Date | null {
  if (events.length === 0) return null;
  return events.reduce(
    (max, event) => (event.occurred_at > max ? event.occurred_at : max),
    events[0].occurred_at
  );
}

/**
 * Keep events at or after the checkpoint watermark. Inclusive (`>=`) so
 * coarse-grained source timestamps (day-level review dates) are not silently
 * dropped; the gateway upserts on (connection_id, origin_id) absorb re-emits.
 */
export function filterByCheckpoint(
  events: EventEnvelope[],
  checkpoint: Record<string, unknown> | null
): EventEnvelope[] {
  const lastTimestamp = checkpoint?.last_timestamp as string | undefined;
  if (!lastTimestamp) return events;

  const cutoff = new Date(lastTimestamp);
  return events.filter((e) => e.occurred_at >= cutoff);
}

export function buildTimestampCheckpoint(
  events: EventEnvelope[],
  previous: Record<string, unknown> | null,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const priorRaw = (previous?.last_timestamp as string | undefined) ?? null;
  const prior = priorRaw ? new Date(priorRaw) : null;
  const newest = maxOccurredAt(events);

  let last_timestamp: string | null;
  if (newest) {
    const candidate = newest.toISOString();
    if (prior && prior.getTime() > newest.getTime()) {
      last_timestamp = prior.toISOString();
    } else {
      last_timestamp = candidate;
    }
  } else {
    last_timestamp = priorRaw;
  }

  return {
    ...extra,
    last_timestamp,
  };
}

export function finalizeTimestampSync(
  events: EventEnvelope[],
  checkpoint: Record<string, unknown> | null,
  options: {
    lookbackDays?: number;
    extra?: Record<string, unknown>;
  } = {}
): { events: EventEnvelope[]; checkpoint: Record<string, unknown> } {
  let filtered = applyLookbackCutoff(events, options.lookbackDays);
  filtered = filterByCheckpoint(filtered, checkpoint);
  filtered.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
  return {
    events: filtered,
    checkpoint: buildTimestampCheckpoint(filtered, checkpoint, options.extra),
  };
}