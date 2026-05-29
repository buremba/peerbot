import { beforeAll, describe, expect, mock, test } from 'bun:test';

// linkedin.ts imports ConnectorRuntime / calculateEngagementScore /
// extensionNetworkSync from @lobu/connector-sdk, which pulls in playwright.
// Stub the SDK so the connector can be imported + instantiated without the
// real browser stack. ConnectorRuntime is a no-op base class here; the
// home-feed path only needs the dispatcher we pass in.
mock.module('@lobu/connector-sdk', () => ({
  ConnectorRuntime: class {},
  calculateEngagementScore: () => 0,
  extensionNetworkSync: () => {
    throw new Error('not used in home_feed unit tests');
  },
}));

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let LinkedInConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let buildHomeFeedEvents: any;

beforeAll(async () => {
  const mod = await import('../linkedin');
  LinkedInConnector = mod.default;
  buildHomeFeedEvents = mod.buildHomeFeedEvents;
});

describe('buildHomeFeedEvents', () => {
  test('maps a token-id row to li_home_<token> with /feed/ source_url', () => {
    const occurredAt = new Date('2026-05-29T12:00:00.000Z');
    const events = buildHomeFeedEvents(
      [{ id: 'aBc123_token', body: 'Hello from the home feed', author: 'Jane Doe' }],
      occurredAt
    );

    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev.origin_id).toBe('li_home_aBc123_token');
    expect(ev.payload_text).toBe('Hello from the home feed');
    expect(ev.author_name).toBe('Jane Doe');
    expect(ev.origin_type).toBe('post');
    // Token id is NOT numeric → no urn:li:activity permalink, link to /feed/.
    expect(ev.source_url).toBe('https://www.linkedin.com/feed/');
    expect(ev.occurred_at).toBe(occurredAt);
    expect(ev.metadata).toEqual({ author: 'Jane Doe' });
  });

  test('defaults author to empty string when missing', () => {
    const [ev] = buildHomeFeedEvents([{ id: 'tok', body: 'body only' }], new Date());
    expect(ev.author_name).toBe('');
    expect(ev.metadata).toEqual({ author: '' });
  });

  test('drops rows without id or body and dedupes by id', () => {
    const events = buildHomeFeedEvents(
      [
        { id: 'a', body: 'first' },
        { id: '', body: 'no id' },
        { id: 'b' }, // no body
        { id: 'a', body: 'dup id' },
      ],
      new Date()
    );
    expect(events.map((e: { origin_id: string }) => e.origin_id)).toEqual(['li_home_a']);
  });
});

describe('LinkedInConnector home_feed', () => {
  test('declares a home_feed feed with no required company_url', () => {
    const def = new LinkedInConnector().definition;
    expect(def.feeds.home_feed).toBeDefined();
    expect(def.feeds.home_feed.configSchema.required).toBeUndefined();
  });

  test('syncHomeFeed dispatches cs_scrape and maps rows to events', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const dispatcher = {
      dispatch: async (action: string, input: Record<string, unknown>) => {
        calls.push({ action, input });
        return {
          tab_id: 1,
          cs_scrape: true,
          result: {
            loggedIn: true,
            rows: [
              { id: 'tok1', body: 'post one', author: 'Alice' },
              { id: 'tok2', body: 'post two', author: 'Bob' },
            ],
          },
        };
      },
    };

    const connector = new LinkedInConnector();
    const ctx = {
      feedKey: 'home_feed',
      config: { max_scrolls: 4 },
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    };
    const res = await connector.sync(ctx);

    // Dispatched a cs_scrape navigate against /feed/ with the home-feed config.
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('navigate');
    expect(calls[0].input.cs_scrape).toBe(true);
    expect(calls[0].input.persistent).toBe(true);
    expect(calls[0].input.url).toBe('https://www.linkedin.com/feed/');
    expect((calls[0].input.scrape_config as { scroll: { max: number } }).scroll.max).toBe(4);

    expect(res.events).toHaveLength(2);
    expect(res.events[0].origin_id).toBe('li_home_tok1');
    expect(res.events[1].origin_id).toBe('li_home_tok2');
    expect(res.metadata.backend).toBe('extension-cs-scrape');
  });

  test('throws a clear error when not logged into LinkedIn', async () => {
    const dispatcher = {
      dispatch: async () => ({ result: { loggedIn: false, rows: [] } }),
    };
    const connector = new LinkedInConnector();
    const ctx = {
      feedKey: 'home_feed',
      config: {},
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    };
    await expect(connector.sync(ctx)).rejects.toThrow(/Not logged into LinkedIn/);
  });
});
