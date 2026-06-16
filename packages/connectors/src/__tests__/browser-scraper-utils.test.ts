import { describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

// Stub @lobu/connector-sdk (it pulls in playwright) so the pure helpers import
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module('@lobu/connector-sdk', connectorSdkMock);

const { applyLookbackCutoff, buildReviewCheckpoint, filterByCheckpoint, validateUrlDomain } =
  await import('../browser-scraper-utils.ts');

describe('validateUrlDomain', () => {
  test('accepts a well-formed https URL on the expected domain', () => {
    expect(() =>
      validateUrlDomain('https://www.trustpilot.com/review/foo', 'trustpilot.com')
    ).not.toThrow();
  });

  test('accepts a subdomain of the expected domain', () => {
    expect(() => validateUrlDomain('https://api.example.com/x', 'example.com')).not.toThrow();
  });

  test('rejects a malformed URL', () => {
    expect(() => validateUrlDomain('not a url', 'example.com')).toThrow(/Invalid example.com URL/);
  });

  test('rejects http (non-https) URLs', () => {
    expect(() => validateUrlDomain('http://www.example.com/', 'example.com')).toThrow(
      /must use https: protocol/
    );
  });

  test('rejects a URL on a different domain', () => {
    expect(() => validateUrlDomain('https://evil.com/foo', 'example.com')).toThrow(
      /must be on example.com/
    );
  });

  test('rejects a substring-match hostname (security: notexample.com is NOT example.com)', () => {
    expect(() => validateUrlDomain('https://notexample.com/x', 'example.com')).toThrow(
      /must be on example.com/
    );
    expect(() => validateUrlDomain('https://eviltrustpilot.com/x', 'trustpilot.com')).toThrow(
      /must be on trustpilot.com/
    );
  });

  test('accepts the apex domain itself (no subdomain)', () => {
    expect(() => validateUrlDomain('https://example.com/x', 'example.com')).not.toThrow();
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

  test('returns every event when checkpoint has no last_timestamp', () => {
    expect(filterByCheckpoint(events, {})).toEqual(events);
  });

  test('keeps only events strictly newer than last_timestamp', () => {
    const filtered = filterByCheckpoint(events, {
      last_timestamp: '2024-06-01T00:00:00Z',
    });
    // strict `>` — event at exactly the cutoff is filtered out
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe(events[2]);
  });

  test('returns empty array when cutoff is past every event', () => {
    expect(
      filterByCheckpoint(events, { last_timestamp: '2099-01-01T00:00:00Z' })
    ).toEqual([]);
  });
});

describe('applyLookbackCutoff', () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const events = [
    { occurred_at: new Date(now - 5 * day) } as any, // 5 days ago
    { occurred_at: new Date(now - 100 * day) } as any, // 100 days ago
    { occurred_at: new Date(now - 400 * day) } as any, // 400 days ago
  ];

  test('returns every event when lookbackDays is undefined', () => {
    expect(applyLookbackCutoff(events, undefined)).toEqual(events);
  });

  test('returns every event when lookbackDays is non-positive', () => {
    expect(applyLookbackCutoff(events, 0)).toEqual(events);
  });

  test('drops events older than the lookback window', () => {
    const filtered = applyLookbackCutoff(events, 365);
    expect(filtered).toHaveLength(2);
    expect(filtered).toContain(events[0]);
    expect(filtered).toContain(events[1]);
    expect(filtered).not.toContain(events[2]);
  });

  test('tightens to a 30-day window', () => {
    const filtered = applyLookbackCutoff(events, 30);
    expect(filtered).toEqual([events[0]]);
  });
});

describe('buildReviewCheckpoint', () => {
  // Events are sorted newest-first by callers, so events[0] is the newest.
  const sorted = [
    { occurred_at: new Date('2024-12-31T00:00:00Z') } as any,
    { occurred_at: new Date('2024-06-01T00:00:00Z') } as any,
  ];

  test('advances last_timestamp to the newest emitted event', () => {
    const cp = buildReviewCheckpoint(sorted, null);
    expect(cp.last_timestamp).toBe('2024-12-31T00:00:00.000Z');
  });

  test('preserves the prior last_timestamp when nothing new was emitted', () => {
    const cp = buildReviewCheckpoint([], { last_timestamp: '2024-06-01T00:00:00.000Z' });
    expect(cp.last_timestamp).toBe('2024-06-01T00:00:00.000Z');
  });

  test('null last_timestamp when empty and no prior checkpoint', () => {
    const cp = buildReviewCheckpoint([], null);
    expect(cp.last_timestamp).toBeNull();
  });

  test('merges extra checkpoint fields alongside last_timestamp', () => {
    const cp = buildReviewCheckpoint(sorted, null, { last_sync_at: 'x', last_page: 1 });
    expect(cp).toMatchObject({
      last_timestamp: '2024-12-31T00:00:00.000Z',
      last_sync_at: 'x',
      last_page: 1,
    });
  });
});

// End-to-end proof of the review-scraper incremental pipeline: the exact
// applyLookbackCutoff -> filterByCheckpoint -> sort -> buildReviewCheckpoint
// sequence each scraper now runs. Proves already-seen reviews are NOT re-emitted
// on the next sync and the checkpoint advances.
describe('review scraper incremental pipeline', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();

  function runPipeline(
    raw: { occurred_at: Date }[],
    checkpoint: Record<string, unknown> | null,
    lookbackDays: number | undefined
  ) {
    let events = applyLookbackCutoff(raw as any, lookbackDays);
    events = filterByCheckpoint(events, checkpoint);
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
    return {
      events,
      checkpoint: buildReviewCheckpoint(events, checkpoint, {
        last_sync_at: new Date().toISOString(),
      }),
    };
  }

  test('first sync emits all in-window reviews and sets the checkpoint', () => {
    const raw = [
      { occurred_at: new Date(now - 1 * day) },
      { occurred_at: new Date(now - 3 * day) },
      { occurred_at: new Date(now - 2 * day) },
    ];
    const first = runPipeline(raw, null, 365);
    expect(first.events).toHaveLength(3);
    // newest-first
    expect(first.events[0].occurred_at.getTime()).toBe(now - 1 * day);
    expect(first.checkpoint.last_timestamp).toBe(new Date(now - 1 * day).toISOString());
  });

  test('second sync re-scrapes the full window but re-emits nothing already seen', () => {
    const raw = [
      { occurred_at: new Date(now - 1 * day) },
      { occurred_at: new Date(now - 3 * day) },
      { occurred_at: new Date(now - 2 * day) },
    ];
    const first = runPipeline(raw, null, 365);

    // Same page re-scraped on the next recurring sync, plus one genuinely new review.
    const newer = { occurred_at: new Date(now) };
    const second = runPipeline([...raw, newer], first.checkpoint, 365);

    // Only the brand-new review is emitted; the three already-seen are dropped.
    expect(second.events).toHaveLength(1);
    expect(second.events[0].occurred_at.getTime()).toBe(now);
    // Checkpoint advances to the newest review.
    expect(second.checkpoint.last_timestamp).toBe(newer.occurred_at.toISOString());
  });

  test('a sync that finds nothing new keeps the checkpoint pinned', () => {
    const raw = [{ occurred_at: new Date(now - 1 * day) }];
    const first = runPipeline(raw, null, 365);
    const second = runPipeline(raw, first.checkpoint, 365);
    expect(second.events).toHaveLength(0);
    expect(second.checkpoint.last_timestamp).toBe(first.checkpoint.last_timestamp);
  });

  test('lookback_days bounds the emit window even on a fresh checkpoint', () => {
    const raw = [
      { occurred_at: new Date(now - 5 * day) },
      { occurred_at: new Date(now - 400 * day) }, // outside a 365-day lookback
    ];
    const result = runPipeline(raw, null, 365);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurred_at.getTime()).toBe(now - 5 * day);
  });
});
