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
  to?: string;
  cc?: string;
  listId?: string;
  precedence?: string;
  date?: string;
}

interface FakeThread {
  id: string;
  messages: FakeMessage[];
}

/**
 * Fake Gmail HTTP client: serves threads.list (one page) and threads/<id>
 * lookups from the given fixtures. Header values come from the per-message
 * fields; snippets are constant.
 */
function fakeHttp(threads: FakeThread[], onRequest?: () => void) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return {
    raw: async (url: string) => {
      onRequest?.();
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
    messages: thread.messages.map((m) => {
      const headers = [
        { name: 'Subject', value: `subject ${thread.id}` },
        { name: 'From', value: m.from ?? 'Some One <someone@example.com>' },
        { name: 'Date', value: m.date ?? '2026-07-01T10:00:00Z' },
      ];
      if (m.to) headers.push({ name: 'To', value: m.to });
      if (m.cc) headers.push({ name: 'Cc', value: m.cc });
      if (m.listId) headers.push({ name: 'List-Id', value: m.listId });
      if (m.precedence) headers.push({ name: 'Precedence', value: m.precedence });
      return {
        id: m.id,
        threadId: thread.id,
        labelIds: m.labelIds ?? [],
        snippet: 'snippet',
        internalDate: String(Date.parse(m.date ?? '2026-07-01T10:00:00Z')),
        payload: { mimeType: 'text/plain', headers },
      };
    }),
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

test('the checkpoint precedes sync requests so messages arriving during sync remain eligible', async () => {
  const connector = new GmailConnector();
  let firstRequestAt = Number.POSITIVE_INFINITY;
  connector.createClient = () =>
    fakeHttp([], () => {
      firstRequestAt = Math.min(firstRequestAt, Date.now());
    });

  const result = await connector.sync({
    config: {},
    credentials: { accessToken: 'tok' },
    checkpoint: {},
  });

  expect(firstRequestAt).toBeFinite();
  expect(new Date(result.checkpoint.last_sync_at).getTime()).toBeLessThanOrEqual(firstRequestAt);
});

test('thread sync includes sent mail and requests the headers mintability depends on', async () => {
  const connector = new GmailConnector();
  const urls: string[] = [];
  connector.createClient = () => ({
    raw: async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes('/threads/')
            ? { id: 't1', historyId: '1', messages: [] }
            : { threads: [{ id: 't1', historyId: '1', snippet: 's' }] },
        text: async () => '',
      } as unknown as Response;
    },
  });

  await connector.sync({ config: {}, credentials: { accessToken: 'tok' }, checkpoint: {} });

  const listQuery = new URL(urls[0]).searchParams.get('q');
  expect(listQuery).toContain('{label:INBOX in:sent}');

  const threadUrl = urls.find((u) => u.includes('/threads/t1'));
  expect(threadUrl).toBeDefined();
  for (const header of ['To', 'Cc', 'Reply-To', 'List-Id', 'Precedence']) {
    expect(threadUrl).toContain(`metadataHeaders=${header}`);
  }
});

describe('Gmail mint-on-send gate', () => {
  test('an inbound-only thread never mints — receipt alone is not a relationship', async () => {
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
    expect(events[0].metadata.outbound).toBe(false);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.mintable).toBe(false);
    expect(events[0].metadata.from_email).toBe('promo@brand.example');
  });

  test('they wrote and we replied — mintable, and attribution stays on the counterparty', async () => {
    const events = await syncThreads([
      {
        id: 't-alice',
        messages: [
          {
            id: 'm1',
            labelIds: ['INBOX'],
            from: 'Alice <alice@example.com>',
            to: 'Me <me@example.com>',
          },
          {
            id: 'm2',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Alice <alice@example.com>',
          },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.outbound).toBe(true);
    expect(events[0].metadata.replied).toBe(true);
    expect(events[0].metadata.mintable).toBe(true);
    expect(events[0].metadata.from_email).toBe('alice@example.com');
  });

  test('cold outbound to a single external recipient mints from the To line', async () => {
    const events = await syncThreads([
      {
        id: 't-cold',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Dana Fox <dana@acme.example>',
          },
        ],
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].metadata.outbound).toBe(true);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.mintable).toBe(true);
    expect(events[0].metadata.from_email).toBe('dana@acme.example');
    expect(events[0].metadata.from_name).toBe('Dana Fox');
  });

  test('outbound to a role mailbox is a ticket, not a contact', async () => {
    const events = await syncThreads([
      {
        id: 't-support',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Support@stripe.com',
          },
        ],
      },
    ]);
    expect(events[0].metadata.outbound).toBe(true);
    expect(events[0].metadata.mintable).toBe(false);
  });

  test('list mail never mints, even when we replied into the list', async () => {
    const listId = await syncThreads([
      {
        id: 't-list',
        messages: [
          {
            id: 'm1',
            labelIds: ['INBOX'],
            from: 'Poster <poster@lists.example>',
            to: 'devs@lists.example',
            listId: '<devs.lists.example>',
          },
          {
            id: 'm2',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Poster <poster@lists.example>',
          },
        ],
      },
    ]);
    expect(listId[0].metadata.mintable).toBe(false);

    const precedence = await syncThreads([
      {
        id: 't-bulk',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Carol <carol@acme.example>',
            precedence: 'Bulk',
          },
        ],
      },
    ]);
    expect(precedence[0].metadata.mintable).toBe(false);
  });

  test('a wide unanswered blast is capped — over three external recipients does not mint', async () => {
    const events = await syncThreads([
      {
        id: 't-blast',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'a@x.example, b@x.example, c@x.example',
            cc: 'd@x.example, e@x.example',
          },
        ],
      },
    ]);
    expect(events[0].metadata.outbound).toBe(true);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.mintable).toBe(false);
  });

  test('three distinct external recipients is within the broadcast cap', async () => {
    const events = await syncThreads([
      {
        id: 't-cap',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Me <me@example.com>, a@x.example, b@x.example',
            cc: 'a@x.example, c@x.example',
          },
        ],
      },
    ]);
    expect(events[0].metadata.mintable).toBe(true);
    expect(events[0].metadata.from_email).toBe('a@x.example');
  });

  test('a SENT-only Cc recipient is not a direct counterparty', async () => {
    const events = await syncThreads([
      {
        id: 't-cc-only',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Me <me@example.com>',
            cc: 'Casey <casey@acme.example>',
          },
        ],
      },
    ]);
    expect(events[0].metadata.mintable).toBe(false);
    expect(events[0].metadata.from_email).toBeUndefined();
  });

  test('the same wide thread mints once a recipient writes back', async () => {
    const events = await syncThreads([
      {
        id: 't-blast-reply',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'a@x.example, b@x.example, c@x.example',
            cc: 'd@x.example, e@x.example',
          },
          { id: 'm2', labelIds: ['INBOX'], from: 'B Person <b@x.example>' },
        ],
      },
    ]);
    expect(events[0].metadata.replied).toBe(true);
    expect(events[0].metadata.mintable).toBe(true);
    expect(events[0].metadata.from_email).toBe('b@x.example');
  });

  test('an owner-started thread attributes the counterparty, never the mailbox owner', async () => {
    const events = await syncThreads([
      {
        id: 't-self',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Bob <bob@example.com>',
          },
          { id: 'm2', labelIds: ['INBOX'], from: 'Bob <bob@example.com>' },
        ],
      },
    ]);
    expect(events[0].metadata.mintable).toBe(true);
    expect(events[0].metadata.from_email).toBe('bob@example.com');
  });

  test('a self-addressed thread (note to self) never mints the owner', async () => {
    const events = await syncThreads([
      {
        id: 't-note',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Me <me@example.com>',
          },
        ],
      },
    ]);
    expect(events[0].metadata.outbound).toBe(true);
    expect(events[0].metadata.mintable).toBe(false);
    expect(events[0].metadata.from_email).toBeUndefined();
  });

  test('an alias-case copy of our own send is not a counterparty reply', async () => {
    // Gmail drops our own sends into the mailbox, and send-as aliases vary in
    // case. Counting that as `replied` would wrongly relax the broadcast cap.
    const events = await syncThreads([
      {
        id: 't-alias',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <ME@Example.com>',
            to: 'a@x.example, b@x.example, c@x.example, d@x.example, e@x.example',
          },
          { id: 'm2', labelIds: ['INBOX'], from: 'me@example.COM' },
        ],
      },
    ]);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.mintable).toBe(false);
  });

  test('a role address on the To line does not sink a real human beside it', async () => {
    const events = await syncThreads([
      {
        id: 't-mixed',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'support@stripe.com, Real Human <human@acme.example>',
          },
        ],
      },
    ]);
    // Attribution skips the role mailbox rather than attributing it and failing.
    expect(events[0].metadata.mintable).toBe(true);
    expect(events[0].metadata.from_email).toBe('human@acme.example');
  });

  test('a bot-opened thread attributes the human who replied, not the bot', async () => {
    const events = await syncThreads([
      {
        id: 't-jira',
        messages: [
          { id: 'm1', labelIds: ['INBOX'], from: 'Jira <notifications@atlassian.com>' },
          { id: 'm2', labelIds: ['INBOX'], from: 'Real Human <human@acme.example>' },
          {
            id: 'm3',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'Real Human <human@acme.example>',
          },
        ],
      },
    ]);
    expect(events[0].metadata.mintable).toBe(true);
    expect(events[0].metadata.from_email).toBe('human@acme.example');
  });

  test('a bot-only thread we answered still does not mint the bot', async () => {
    const events = await syncThreads([
      {
        id: 't-bot-only',
        messages: [
          { id: 'm1', labelIds: ['INBOX'], from: 'Jira <notifications@atlassian.com>' },
          {
            id: 'm2',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: 'notifications@atlassian.com',
          },
        ],
      },
    ]);
    expect(events[0].metadata.replied).toBe(true);
    expect(events[0].metadata.mintable).toBe(false);
  });

  test('a SENT message with no parseable From fails closed — self is unknowable', async () => {
    const events = await syncThreads([
      {
        id: 't-nofrom',
        messages: [{ id: 'm1', labelIds: ['SENT'], from: '', to: 'Dana <dana@acme.example>' }],
      },
    ]);
    expect(events[0].metadata.outbound).toBe(true);
    expect(events[0].metadata.mintable).toBe(false);
  });

  test('a display name containing a comma does not split into two recipients', async () => {
    const events = await syncThreads([
      {
        id: 't-comma',
        messages: [
          {
            id: 'm1',
            labelIds: ['SENT'],
            from: 'Me <me@example.com>',
            to: '"Doe, Jane" <jane@acme.example>',
          },
        ],
      },
    ]);
    expect(events[0].metadata.mintable).toBe(true);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });
});

describe('Gmail person attribution rule', () => {
  test('autoCreate is gated on metadata.mintable — promotion follows the send, not the receipt', () => {
    const connector = new GmailConnector();
    const rules = connector.definition.feeds.threads.eventKinds.thread.attributions;
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.role).toBe('authored_by');
    expect(rule.autoCreate).toBe(true);
    expect(rule.target.entityType).toBe('person');
    expect(rule.target.createWhen).toEqual({ path: 'metadata.mintable', equals: true });
    expect(rule.target.identities).toEqual([
      { namespace: 'email', eventPath: 'metadata.from_email' },
    ]);
  });
});
