import { describe, expect, test } from 'bun:test';
import { applyLookbackCutoff } from '../checkpoint/lookback.js';
import {
  buildTimestampCheckpoint,
  filterByCheckpoint,
  finalizeTimestampSync,
} from '../checkpoint/timestamp-watermark.js';
import { validateUrlDomain } from '../url-guards.js';

describe('validateUrlDomain', () => {
  test('accepts a well-formed https URL on the expected domain', () => {
    expect(() =>
      validateUrlDomain('https://www.trustpilot.com/review/foo', 'trustpilot.com')
    ).not.toThrow();
  });

  test('rejects a substring-match hostname', () => {
    expect(() => validateUrlDomain('https://eviltrustpilot.com/x', 'trustpilot.com')).toThrow(
      /must be on trustpilot.com/
    );
  });
});

describe('filterByCheckpoint', () => {
  const events = [
    { occurred_at: new Date('2024-01-01T00:00:00Z') } as any,
    { occurred_at: new Date('2024-06-01T00:00:00Z') } as any,
    { occurred_at: new Date('2024-12-31T00:00:00Z') } as any,
  ];

  test('returns every event when no checkpoint is set', () => {
    expect(filterByCheckpoint(events, null)).toEqual(events);
  });

  test('keeps events at or after last_timestamp (inclusive watermark)', () => {
    const filtered = filterByCheckpoint(events, {
      last_timestamp: '2024-06-01T00:00:00Z',
    });
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toBe(events[1]);
    expect(filtered[1]).toBe(events[2]);
  });

  test('re-emits same-timestamp items for coarse-grained review dates', () => {
    const day = new Date('2024-06-15T00:00:00Z');
    const sameDay = [
      { occurred_at: day, origin_id: 'a' } as any,
      { occurred_at: day, origin_id: 'b' } as any,
    ];
    const filtered = filterByCheckpoint(sameDay, {
      last_timestamp: day.toISOString(),
    });
    expect(filtered).toHaveLength(2);
  });
});

describe('buildTimestampCheckpoint', () => {
  test('uses max occurred_at even when events are unsorted', () => {
    const unsorted = [
      { occurred_at: new Date('2024-06-01T00:00:00Z') } as any,
      { occurred_at: new Date('2024-12-31T00:00:00Z') } as any,
    ];
    const cp = buildTimestampCheckpoint(unsorted, null);
    expect(cp.last_timestamp).toBe('2024-12-31T00:00:00.000Z');
  });

  test('never regresses the watermark when extraction returns older items only', () => {
    const cp = buildTimestampCheckpoint(
      [{ occurred_at: new Date('2024-01-01T00:00:00Z') } as any],
      { last_timestamp: '2024-12-31T00:00:00.000Z' }
    );
    expect(cp.last_timestamp).toBe('2024-12-31T00:00:00.000Z');
  });

});

describe('finalizeTimestampSync', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();

  function runPipeline(
    raw: { occurred_at: Date }[],
    checkpoint: Record<string, unknown> | null,
    lookbackDays: number | undefined
  ) {
    return finalizeTimestampSync(raw as any, checkpoint, {
      lookbackDays,
      extra: { last_sync_at: new Date().toISOString() },
    });
  }

  test('second sync re-emits watermark-boundary items and anything newer', () => {
    const raw = [
      { occurred_at: new Date(now - 1 * day) },
      { occurred_at: new Date(now - 3 * day) },
    ];
    const first = runPipeline(raw, null, 365);

    const newer = { occurred_at: new Date(now) };
    const second = runPipeline([...raw, newer], first.checkpoint, 365);

    // Inclusive watermark: the newest item from the prior sync (now - 1 day) is
    // re-emitted alongside genuinely new items; upsert dedups at the gateway.
    expect(second.events).toHaveLength(2);
    expect(second.events[0].occurred_at.getTime()).toBe(now);
    expect(second.events[1].occurred_at.getTime()).toBe(now - 1 * day);
  });

  test('lookback_days bounds the emit window', () => {
    const raw = [
      { occurred_at: new Date(now - 5 * day) },
      { occurred_at: new Date(now - 400 * day) },
    ];
    const result = runPipeline(raw, null, 365);
    expect(result.events).toHaveLength(1);
  });
});

describe('applyLookbackCutoff', () => {
  test('drops events older than the lookback window', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const events = [
      { occurred_at: new Date(now - 5 * day) } as any,
      { occurred_at: new Date(now - 400 * day) } as any,
    ];
    const filtered = applyLookbackCutoff(events, 365);
    expect(filtered).toHaveLength(1);
  });
});