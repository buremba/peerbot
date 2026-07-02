import type { EventEnvelope } from '../connector-types.js';

export function applyLookbackCutoff(
  events: EventEnvelope[],
  lookbackDays: number | undefined
): EventEnvelope[] {
  if (!lookbackDays || lookbackDays <= 0) return events;
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  return events.filter((e) => e.occurred_at >= cutoff);
}