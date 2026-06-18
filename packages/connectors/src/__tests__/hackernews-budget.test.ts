// #1365: the stories sync must not stall on a broad query with blocked egress.
// We import the REAL SDK (no process-global mock.module — that leaks across the
// run) and stub only global.fetch: one Algolia page of high-engagement stories,
// then content fetches that always fail (egress down). The connector must
// short-circuit enrichment after a few consecutive failures instead of grinding
// through every story at ~5s each.

import { afterEach, beforeEach, expect, test } from 'bun:test';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function algoliaPage(n: number) {
  return {
    hits: Array.from({ length: n }, (_, i) => ({
      objectID: String(i),
      created_at: '2026-01-01T00:00:00Z',
      created_at_i: 1_767_225_600,
      author: 'someone',
      title: `Story ${i}`,
      url: `https://example.com/article-${i}`,
      points: 200, // > ENGAGEMENT_THRESHOLD (50) so each is an enrichment candidate
      num_comments: 10,
      story_id: i,
      _tags: ['story'],
    })),
    nbHits: n,
    page: 0,
    nbPages: 1, // single page → pagination stops immediately
    hitsPerPage: 100,
  };
}

let contentFetches = 0;
beforeEach(() => {
  contentFetches = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('hn.algolia.com')) {
      return new Response(JSON.stringify(algoliaPage(20)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Content enrichment fetch → simulate blocked egress (always fails).
    contentFetches++;
    throw new Error('network unreachable');
  }) as typeof fetch;
});

test('stories enrichment short-circuits after consecutive egress failures', async () => {
  const { default: HackerNewsConnector } = await import('../hackernews');
  const connector = new HackerNewsConnector();
  const logs: string[] = [];
  const ctx = {
    feedKey: 'stories',
    config: { search_query: 'AI agents' },
    log: (m: string) => logs.push(m),
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal SyncContext for unit test
  const result = await connector.sync(ctx as any);

  // All 20 stories are still returned — enrichment is best-effort.
  expect(result.events.length).toBe(20);
  // But we stopped fetching content after the consecutive-failure threshold (3),
  // not after all 20 — that's the anti-stall guard.
  expect(contentFetches).toBeLessThanOrEqual(3);
  expect(logs.some((l) => l.includes('consecutive content fetches failed'))).toBe(true);
}, 20_000);
