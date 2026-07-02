/**
 * Gmail virtual-feed pushdown (PR #1702) — the connector half of the seam.
 *
 * The DB-level `readVirtualFeed` seam is covered by `virtual-feed-read.test.ts`
 * (with the postgres connector as the stand-in source). This test covers the
 * NEW Gmail code that seam dispatches into: `GmailConnector.query()`/`search()`
 * → `liveSearch()` → `listMessageIds()` + `fetchMessageRows()`.
 *
 * The only external dependency — the Gmail HTTP API — is stubbed at the
 * `HttpClient.raw()` boundary (the connector's single egress seam), so this is
 * deterministic and needs no network or DB. It verifies:
 *  - query() builds the Gmail `q` from `ctx.query` alone;
 *  - search() ANDs the recall `terms` onto `q` (Gmail `q` is space-separated);
 *  - the stable column set + row shape (id, thread_id, subject, from fields, date, snippet, url);
 *  - the limit is clamped and passed as maxResults, capping the id list;
 *  - offset pages forward then drops the leading rows;
 *  - an unsupported sort is rejected (Gmail is always date-desc), and no total is reported;
 *  - a single unreadable message (non-2xx metadata fetch) is skipped, not fatal;
 *  - missing credentials and an empty `q` throw.
 */

import { describe, expect, it } from 'vitest';
import GmailConnector from '@lobu/connectors/google_gmail';

// --- Gmail API fixtures --------------------------------------------------

interface FakeMessage {
  id: string;
  threadId: string;
  snippet: string;
  headers: Record<string, string>;
}

const MESSAGES: FakeMessage[] = [
  {
    id: 'm1',
    threadId: 't1',
    snippet: 'Quarterly report attached',
    headers: { Subject: 'Q2 report', From: 'Alice Smith <alice@acme.com>', Date: 'Tue, 01 Jul 2026 10:00:00 +0000' },
  },
  {
    id: 'm2',
    threadId: 't2',
    snippet: 'Lunch?',
    headers: { Subject: 'lunch tomorrow', From: 'bob@acme.com', Date: 'Wed, 02 Jul 2026 09:00:00 +0000' },
  },
  {
    id: 'm3',
    threadId: 't3',
    snippet: 'no subject here',
    headers: { From: 'Unknown', Date: '' }, // no Subject header → '(no subject)'
  },
];

/** Records the `q` values the connector actually requested against messages.list. */
interface Capture {
  listQueries: string[];
  listMaxResults: number[];
}

/**
 * Build a fake `HttpClient` that answers Gmail's messages.list + messages.get
 * (metadata) endpoints from `messages`. The list endpoint honors `maxResults`
 * and `pageToken` (real forward pagination), so offset/limit slicing is exercised
 * end-to-end. `unreadable` ids return a non-2xx from the metadata fetch so we can
 * assert the skip-on-404 path.
 */
function fakeClient(
  capture: Capture,
  opts: { unreadable?: Set<string>; messages?: FakeMessage[] } = {},
) {
  const unreadable = opts.unreadable ?? new Set<string>();
  const corpus = opts.messages ?? MESSAGES;
  const raw = async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname.endsWith('/messages')) {
      capture.listQueries.push(u.searchParams.get('q') ?? '');
      const maxResults = Number(u.searchParams.get('maxResults'));
      capture.listMaxResults.push(maxResults);
      // pageToken is a numeric cursor into `corpus`; return maxResults ids then
      // the next cursor if more remain.
      const start = Number(u.searchParams.get('pageToken') ?? '0');
      const slice = corpus.slice(start, start + maxResults);
      const next = start + maxResults;
      return new Response(
        JSON.stringify({
          messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })),
          ...(next < corpus.length ? { nextPageToken: String(next) } : {}),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // messages/{id}?format=metadata
    const idMatch = u.pathname.match(/\/messages\/([^/]+)$/);
    if (idMatch) {
      const id = idMatch[1];
      if (unreadable.has(id)) return new Response('not found', { status: 404 });
      const msg = corpus.find((m) => m.id === id);
      if (!msg) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({
          id: msg.id,
          threadId: msg.threadId,
          snippet: msg.snippet,
          payload: { headers: Object.entries(msg.headers).map(([name, value]) => ({ name, value })) },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected url: ${url}`);
  };
  // Only raw() is used by the pushdown; the rest satisfy the interface unused.
  return {
    raw,
    request: raw,
    json: async () => ({}),
    get: async () => ({}),
    post: async () => ({}),
  } as unknown as import('@lobu/connector-sdk').HttpClient;
}

/** A GmailConnector whose HTTP boundary is the fake client. */
function connectorWith(
  capture: Capture,
  opts?: { unreadable?: Set<string>; messages?: FakeMessage[] },
) {
  const c = new GmailConnector();
  // createClient is `private` at the type level only — override at runtime so
  // liveSearch() talks to the fake instead of real Gmail.
  (c as unknown as { createClient: () => unknown }).createClient = () => fakeClient(capture, opts);
  return c;
}

const CREDS = { credentials: { accessToken: 'fake-token' } };

describe('Gmail virtual-feed pushdown', () => {
  it('query() builds q from ctx.query alone and returns the stable row shape', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    const res = await c.query({ ...CREDS, query: 'in:inbox newer_than:30d', config: {}, limit: 10 } as never);

    expect(cap.listQueries).toEqual(['in:inbox newer_than:30d']);
    expect(res.columns.map((col) => col.name)).toEqual([
      'id', 'thread_id', 'subject', 'from', 'from_name', 'from_email', 'date', 'snippet', 'url',
    ]);
    expect(res.rows).toHaveLength(3);
    expect(res.rows[0]).toMatchObject({
      id: 'm1',
      thread_id: 't1',
      subject: 'Q2 report',
      from: 'Alice Smith <alice@acme.com>',
      from_name: 'Alice Smith',
      from_email: 'alice@acme.com',
      url: 'https://mail.google.com/mail/u/0/#inbox/t1',
    });
    // header-less message falls back cleanly
    expect(res.rows[2]).toMatchObject({ subject: '(no subject)', from_name: null, from_email: null });
  });

  it('does not report a (misleading) total for a partial page', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    const res = await c.query({ ...CREDS, query: 'in:inbox', config: {}, limit: 10 } as never);
    // Gmail gives no reliable match count — omitting total avoids reporting the
    // page length as if it were the grand total.
    expect(res.total).toBeUndefined();
  });

  it('search() ANDs recall terms onto the base q (bare tokens pass through)', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    await c.search({ ...CREDS, query: 'in:inbox', terms: ['report', 'urgent'], config: {}, limit: 5 } as never);
    // Gmail q is space-separated = AND
    expect(cap.listQueries).toEqual(['in:inbox report urgent']);
  });

  it('search() quotes a term containing spaces so it matches literally', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    await c.search({ ...CREDS, query: 'in:inbox', terms: ['weekly report'], config: {}, limit: 5 } as never);
    expect(cap.listQueries).toEqual(['in:inbox "weekly report"']);
  });

  it('search() quotes an operator-like term so it is matched literally, not reparsed', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    // A recall term is keyword text, not Gmail query syntax — `from:alice@x.com`
    // must be a literal phrase, not activate the `from:` operator (operators
    // belong in the base config.query, not in recall terms).
    await c.search({ ...CREDS, query: 'in:inbox', terms: ['from:alice@x.com'], config: {}, limit: 5 } as never);
    expect(cap.listQueries).toEqual(['in:inbox "from:alice@x.com"']);
  });

  it('clamps the limit and passes it as maxResults', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    // limit 2 → maxResults 2, id list capped to 2 even though 3 fixtures exist
    const res = await c.query({ ...CREDS, query: 'in:inbox', config: {}, limit: 2 } as never);
    expect(cap.listMaxResults[0]).toBe(2);
    expect(res.rows).toHaveLength(2);
  });

  it('applies offset by paging forward then dropping the leading rows', async () => {
    // 5-message corpus, offset 2 + limit 2 → rows m3, m4 (m1, m2 dropped).
    const corpus: FakeMessage[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i + 1}`,
      threadId: `t${i + 1}`,
      snippet: `msg ${i + 1}`,
      headers: { Subject: `Subject ${i + 1}`, From: `s${i + 1}@acme.com`, Date: '' },
    }));
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap, { messages: corpus });
    const res = await c.query({ ...CREDS, query: 'in:inbox', config: {}, limit: 2, offset: 2 } as never);
    expect(res.rows.map((r) => r.id)).toEqual(['m3', 'm4']);
  });

  it('rejects an unsupported sort (Gmail is always date-desc)', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    await expect(
      c.query({ ...CREDS, query: 'in:inbox', config: {}, sort: { column: 'subject', order: 'asc' } } as never),
    ).rejects.toThrow(/only supports sort/i);
    // …but the natural date-desc sort is accepted.
    const ok = await c.query({ ...CREDS, query: 'in:inbox', config: {}, sort: { column: 'date', order: 'desc' } } as never);
    expect(ok.rows.length).toBeGreaterThan(0);
  });

  it('skips a single unreadable message instead of failing the batch', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap, { unreadable: new Set(['m2']) });
    const res = await c.query({ ...CREDS, query: 'in:inbox', config: {}, limit: 10 } as never);
    expect(res.rows.map((r) => r.id)).toEqual(['m1', 'm3']); // m2 skipped
  });

  it('throws without credentials', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    await expect(c.query({ query: 'in:inbox', config: {} } as never)).rejects.toThrow(/OAuth credentials/i);
  });

  it('throws when there is no q (empty base and no terms)', async () => {
    const cap: Capture = { listQueries: [], listMaxResults: [] };
    const c = connectorWith(cap);
    await expect(c.query({ ...CREDS, query: '', config: {} } as never)).rejects.toThrow(/no `query`|no search terms/i);
  });
});
