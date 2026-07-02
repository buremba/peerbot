import { describe, expect, test } from 'bun:test';
import { filterByCheckpoint } from '../scraper-utils.ts';

describe('filterByCheckpoint', () => {
  const events = [
    { occurred_at: new Date('2024-01-01T00:00:00Z') } as any,
    { occurred_at: new Date('2024-06-01T00:00:00Z') } as any,
    { occurred_at: new Date('2024-12-31T00:00:00Z') } as any,
  ];

  test('returns every event when no checkpoint is set', () => {
    expect(filterByCheckpoint(events, null)).toEqual(events);
  });

  test('keeps events at or after last_timestamp', () => {
    const filtered = filterByCheckpoint(events, {
      last_timestamp: '2024-06-01T00:00:00Z',
    });
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toBe(events[1]);
    expect(filtered[1]).toBe(events[2]);
  });
});