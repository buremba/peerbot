import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let GmailConnector: any;

beforeAll(async () => {
  const mod = await import('../google_gmail');
  GmailConnector = mod.default;
});

interface FakeMessage {
  id: string;
  labelIds?: string[];
  from?: string;
  date?: string;
}

interface FakeThread {
  id: string;
  messages: FakeMessage[];
}

/**
 * Fake Gmail HTTP client: serves threads.list (one page) and threads/<id>
 * lookups from the given fixtures. Header values come from the per-message
 * `from`/`date` fields; snippets are constant.
 */
function fakeHttp(threads: FakeThread[]) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return {
    raw: async (url: string) => {
      const u = new URL(url);
      const threadMatch = u.pathname.match(/\/threads\/([^/]+)$/);
      const body = threadMatch
        ? toThreadResponse(byId.get(threadMatch[1]))
        : { threads: threads.map((t) => ({ id: t.id, historyId: '1', snippet: 's' })) };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => '',
      } as unknown as Response;
    },
  };
}

function toThreadResponse(thread: FakeThread | undefined) {
  if (!thread) return { id: 'missing', historyId: '1', messages: [] };
  return {
    id: thread.id,
    historyId: '1',
    messages: thread.messages.map((m) => ({
      id: m.id,
      threadId: thread.id,
      labelIds: m.labelIds ?? [],
      snippet: 'snippet',
      internalDate: String(Date.parse(m.date ?? '2026-07-01T10:00:00Z')),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: `subject ${thread.id}` },
          { name: 'From', value: m.from ?? 'Some One <someone@example.com>' },
          { name: 'Date', value: m.date ?? '2026-07-01T10:00:00Z' },
        ],
      },
    })),
  };
}

async function syncThreads(threads: FakeThread[]) {
  const connector = new GmailConnector();
  connector.createClient = () => fakeHttp(threads);
  const result = await connector.sync({
    config: {},
    credentials: { accessToken: 'tok' },
    checkpoint: {},
  });
  return result.events as Array<{ origin_id: string; metadata: Record<string, unknown> }>;
}

describe('Gmail replied signal (promote-on-interaction)', () => {
  test('an inbound-only thread is NOT replied — a bulk sender/brand never clears the bar', async () => {
    const events = await syncThreads([
      {
        id: 't-brand',
        messages: [
          { id: 'm1', labelIds: ['INBOX'], from: 'Brand <promo@brand.example>' },
          { id: 'm2', labelIds: ['INBOX'], from: 'Brand <promo@brand.example>' },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.from_email).toBe('promo@brand.example');
  });

  test('a counterparty-started thread the owner replied in IS replied', async () => {
    const events = await syncThreads([
      {
        id: 't-alice',
        messages: [
          { id: 'm1', labelIds: ['INBOX'], from: 'Alice <alice@example.com>' },
          { id: 'm2', labelIds: ['SENT'], from: 'Me <me@example.com>' },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(true);
    expect(events[0].metadata.from_email).toBe('alice@example.com');
  });

  test('an owner-started thread is NOT replied — from_email is the owner, never promote self', async () => {
    const events = await syncThreads([
      {
        id: 't-self',
        messages: [
          { id: 'm1', labelIds: ['SENT'], from: 'Me <me@example.com>' },
          { id: 'm2', labelIds: ['INBOX'], from: 'Bob <bob@example.com>' },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(false);
  });
});

describe('Gmail person attribution rule', () => {
  test('autoCreate is on but gated on metadata.replied — promotion is interaction-driven', () => {
    const connector = new GmailConnector();
    const rules = connector.definition.feeds.threads.eventKinds.thread.attributions;
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.role).toBe('authored_by');
    expect(rule.autoCreate).toBe(true);
    expect(rule.target.entityType).toBe('person');
    expect(rule.target.createWhen).toEqual({ path: 'metadata.replied', equals: true });
    expect(rule.target.identities).toEqual([
      { namespace: 'email', eventPath: 'metadata.from_email' },
    ]);
  });
});
