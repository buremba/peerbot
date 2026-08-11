import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let GmailConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let isPersonRelevantSender: any;

beforeAll(async () => {
  const mod = await import('../google_gmail');
  GmailConnector = mod.default;
  isPersonRelevantSender = mod.isPersonRelevantSender;
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
 * `from`/`date` fields; snippets are constant. `failThreadIds` respond 404.
 */
function fakeHttp(
  threads: FakeThread[],
  onRequest?: (url: string) => void,
  failThreadIds: ReadonlySet<string> = new Set()
) {
  const byId = new Map(threads.map((t) => [t.id, t]));
  return {
    raw: async (url: string) => {
      onRequest?.(url);
      const u = new URL(url);
      const threadMatch = u.pathname.match(/\/threads\/([^/]+)$/);
      if (threadMatch && failThreadIds.has(threadMatch[1])) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => '',
        } as unknown as Response;
      }
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
          ...(m.to ? [{ name: 'To', value: m.to }] : []),
          ...(m.cc ? [{ name: 'Cc', value: m.cc }] : []),
          ...(m.listId ? [{ name: 'List-Id', value: m.listId }] : []),
          ...(m.precedence ? [{ name: 'Precedence', value: m.precedence }] : []),
          { name: 'Date', value: m.date ?? '2026-07-01T10:00:00Z' },
        ],
      },
    })),
  };
}

async function syncThreads(threads: FakeThread[], config: Record<string, unknown> = {}) {
  const connector = new GmailConnector();
  connector.createClient = () => fakeHttp(threads);
  const result = await connector.sync({
    config,
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

test('person-building sync requests its label union and attribution headers', async () => {
  const urls: string[] = [];
  const connector = new GmailConnector();
  connector.createClient = () =>
    fakeHttp(
      [
        {
          id: 't-human',
          messages: [
            { id: 'm1', labelIds: ['INBOX'], from: 'Jane Doe <jane@acme.example>' },
          ],
        },
      ],
      (url) => urls.push(url)
    );

  await connector.sync({
    config: { labels: [' INBOX ', 'SENT'], human_senders_only: true },
    credentials: { accessToken: 'tok' },
    checkpoint: {},
  });

  expect(new URL(urls[0]).searchParams.get('q')).toContain('{label:INBOX label:SENT}');
  const threadUrl = urls.find((url) => url.includes('/threads/t-human')) ?? '';
  for (const header of ['To', 'Cc', 'List-Id', 'Precedence']) {
    expect(threadUrl).toContain(`metadataHeaders=${header}`);
  }
});

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

  test('an owner-started thread with a counterparty reply is bidirectional and attributes the counterparty', async () => {
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
    expect(events[0].metadata.replied).toBe(true);
    expect(events[0].metadata.from_email).toBe('bob@example.com');
  });
});

describe('Gmail person attribution rule', () => {
  test('bumps the connector version for the changed sync contract', () => {
    expect(new GmailConnector().definition.version).toBe('1.0.4');
  });

  test('autoCreate is on but gated on metadata.person_relevant — promotion is interaction/human driven', () => {
    const connector = new GmailConnector();
    const rules = connector.definition.feeds.threads.eventKinds.thread.attributions;
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.role).toBe('authored_by');
    expect(rule.autoCreate).toBe(true);
    expect(rule.target.entityType).toBe('person');
    expect(rule.target.createWhen).toEqual({ path: 'metadata.person_relevant', equals: true });
    expect(rule.target.identities).toEqual([
      { namespace: 'email', eventPath: 'metadata.from_email' },
    ]);
  });
});

describe('isPersonRelevantSender', () => {
  test('a reply makes a non-role sender relevant but never turns a role mailbox into a person', () => {
    expect(isPersonRelevantSender('promo@brand.example', 'Brand', true)).toBe(true);
    expect(isPersonRelevantSender('noreply@brand.example', 'No Reply', true)).toBe(false);
  });

  test('automated / shared local-parts never pass on receipt alone', () => {
    for (const email of [
      'noreply@brand.example',
      'no-reply@brand.example',
      'noreply+receipt@brand.example',
      'donotreply@brand.example',
      'bounce@mailer.example',
      'mailer-daemon@example.com',
      'postmaster@example.com',
      'info@acme.example',
      'marketing@acme.example',
      'support@acme.example',
      'hello@acme.example',
      'notifications@acme.example',
      'alerts@acme.example',
      'team@acme.example',
      'newsletter@acme.example',
    ]) {
      expect(isPersonRelevantSender(email, 'Acme', false)).toBe(false);
    }
  });

  test('consumer-mail domains pass even without a display name', () => {
    expect(isPersonRelevantSender('jane.doe@gmail.com', null, false)).toBe(true);
    expect(isPersonRelevantSender('bob@proton.me', '', false)).toBe(true);
  });

  test('a human-looking name passes a corporate domain', () => {
    expect(isPersonRelevantSender('john.smith@acme.example', 'John Smith', false)).toBe(true);
  });

  test('single-word brands and unnamed corporate addresses fail', () => {
    expect(isPersonRelevantSender('team@linkedin.example', 'LinkedIn', false)).toBe(false);
    expect(isPersonRelevantSender('john.smith@acme.example', null, false)).toBe(false);
  });

  test('plural role local-parts are rejected too (newsletters, contacts)', () => {
    expect(isPersonRelevantSender('newsletters@acme.example', 'Acme Newsletters', false)).toBe(false);
    expect(isPersonRelevantSender('contacts@acme.example', 'Acme Contacts', false)).toBe(false);
  });

  test('missing / unparseable addresses are never human', () => {
    expect(isPersonRelevantSender(null, 'John Smith', false)).toBe(false);
    expect(isPersonRelevantSender('not-an-email', 'John Smith', false)).toBe(false);
    expect(isPersonRelevantSender('', 'John Smith', false)).toBe(false);
  });
});

describe('Gmail human_senders_only sync mode', () => {
  test('drops brand/automated threads and emits only person-relevant ones', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-brand',
          messages: [
            { id: 'm1', labelIds: ['INBOX'], from: 'Brand <promo@brand.example>' },
          ],
        },
        {
          id: 't-human',
          messages: [
            { id: 'm1', labelIds: ['INBOX'], from: 'Jane Doe <jane@acme.example>' },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events.map((e) => e.origin_id).sort()).toEqual(['t-human']);
    expect(events[0].metadata.person_relevant).toBe(true);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('stamps person_relevant on replied threads and keeps them', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-alice',
          messages: [
            { id: 'm1', labelIds: ['INBOX'], from: 'Alice <alice@example.com>' },
            { id: 'm2', labelIds: ['SENT'], from: 'Me <me@example.com>' },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.person_relevant).toBe(true);
    expect(events[0].metadata.replied).toBe(true);
  });

  test('an outbound-only thread attributes the recipient via the To header', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-out',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Bob Smith <bob@example.com>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.person_relevant).toBe(true);
    expect(events[0].metadata.from_email).toBe('bob@example.com');
    expect(events[0].metadata.from_name).toBe('Bob Smith');
  });

  test('skips a role recipient and attributes a human beside it', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-mixed',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'support@vendor.example, Jane Doe <jane@acme.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('attributes a human reply instead of the automated sender that opened the thread', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-bot-first',
          messages: [
            {
              id: 'm1',
              labelIds: ['INBOX'],
              from: 'Notifications <notifications@vendor.example>',
            },
            {
              id: 'm2',
              labelIds: ['INBOX'],
              from: 'Jane Doe <jane@acme.example>',
            },
            {
              id: 'm3',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Jane Doe <jane@acme.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('does not count a case-varying copy of the mailbox owner as a reply', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-self-copy',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <ME@example.com>',
              to: 'Jane Doe <jane@acme.example>',
            },
            { id: 'm2', labelIds: ['INBOX'], from: 'me@EXAMPLE.com' },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata.replied).toBe(false);
    expect(events[0].metadata.from_email).toBe('jane@acme.example');
  });

  test('fails closed on outbound attribution when the mailbox address is unknown', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-no-self',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: '',
              to: 'Jane Doe <jane@acme.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(0);
  });

  test('drops list threads and unreplied wide broadcasts', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-list',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Jane Doe <jane@acme.example>',
              listId: '<people.vendor.example>',
            },
          ],
        },
        {
          id: 't-blast',
          messages: [
            {
              id: 'm1',
              labelIds: ['SENT'],
              from: 'Me <me@example.com>',
              to: 'Alice One <a@one.example>, Bob Two <b@two.example>',
              cc: 'Carol Three <c@three.example>, David Four <d@four.example>',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    expect(events).toHaveLength(0);
  });

  test('default mode keeps replied semantics and stamps person_relevant = replied', async () => {
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
    expect(events[0].metadata.person_relevant).toBe(true);
  });

  test('a Gmail plus-tag copy of the mailbox owner is never treated as external', async () => {
    const events = await syncThreads(
      [
        {
          id: 't-tag-self',
          messages: [
            { id: 'm1', labelIds: ['SENT'], from: 'Me <me+archive@example.com>' },
            {
              id: 'm2',
              labelIds: ['INBOX'],
              from: 'me@example.com',
            },
          ],
        },
      ],
      { human_senders_only: true }
    );
    // The INBOX copy is the owner via a +tag alias, not a reply from a person.
    expect(events).toHaveLength(0);
  });

  test('failed thread GETs consume max_results (cap bounds API calls)', async () => {
    const connector = new GmailConnector();
    const urls: string[] = [];
    connector.createClient = () =>
      fakeHttp(
        [
          {
            id: 't-missing',
            messages: [
              { id: 'm1', labelIds: ['INBOX'], from: 'Bob <bob@acme.example>' },
            ],
          },
          {
            id: 't-ok',
            messages: [
              { id: 'm1', labelIds: ['INBOX'], from: 'Jane Doe <jane@acme.example>' },
            ],
          },
        ],
        (url) => urls.push(url),
        new Set(['t-missing'])
      );

    await connector.sync({
      config: { max_results: 1, human_senders_only: true },
      credentials: { accessToken: 'tok' },
      checkpoint: {},
    });

    // max_results=1: the 404 consumes the cap, so only ONE thread GET runs.
    const threadGets = urls.filter((url) => url.includes('/threads/'));
    expect(threadGets).toHaveLength(1);
    expect(threadGets[0]).toContain('t-missing');
  });
});

describe('Gmail write scope', () => {
  // create_draft POSTs to /drafts, which the Gmail API authorizes only under
  // gmail.compose (or the broader gmail.modify) — gmail.readonly and gmail.send
  // are both insufficient for drafts.create. compose must be REQUIRED, not
  // optional: optional scopes are only sent when the caller explicitly requests
  // them, so an unadorned connect() would omit it and create_draft would 403.
  test('compose is a required scope so create_draft/reply/send_email are authorized', () => {
    const connector = new GmailConnector();
    const oauth = connector.definition.authSchema.methods.find(
      (m: { type: string }) => m.type === 'oauth'
    );
    expect(oauth.requiredScopes).toContain('https://www.googleapis.com/auth/gmail.compose');

    const actions = connector.definition.actions;
    for (const key of ['create_draft', 'reply', 'send_email']) {
      expect(actions[key]).toBeDefined();
      expect(actions[key].key).toBe(key);
    }
  });
});
