import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { connectorSdkMock } from './connector-sdk.mock';

mock.module('@lobu/connector-sdk', () => connectorSdkMock());

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let GmailConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let isHumanSender: any;

beforeAll(async () => {
  const mod = await import('../google_gmail');
  GmailConnector = mod.default;
  isHumanSender = mod.isHumanSender;
});

interface FakeMessage {
  id: string;
  labelIds?: string[];
  from?: string;
  to?: string;
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

describe('isHumanSender', () => {
  test('replied threads are always human regardless of address shape', () => {
    expect(isHumanSender('promo@brand.example', 'Brand', true)).toBe(true);
    expect(isHumanSender('noreply@brand.example', 'No Reply', true)).toBe(true);
  });

  test('automated / shared local-parts never pass on receipt alone', () => {
    for (const email of [
      'noreply@brand.example',
      'no-reply@brand.example',
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
      expect(isHumanSender(email, 'Acme', false)).toBe(false);
    }
  });

  test('consumer-mail domains pass even without a display name', () => {
    expect(isHumanSender('jane.doe@gmail.com', null, false)).toBe(true);
    expect(isHumanSender('bob@proton.me', '', false)).toBe(true);
  });

  test('a human-looking name passes a corporate domain', () => {
    expect(isHumanSender('john.smith@acme.example', 'John Smith', false)).toBe(true);
  });

  test('single-word brands and unnamed corporate addresses fail', () => {
    expect(isHumanSender('team@linkedin.example', 'LinkedIn', false)).toBe(false);
    expect(isHumanSender('john.smith@acme.example', null, false)).toBe(false);
  });

  test('missing / unparseable addresses are never human', () => {
    expect(isHumanSender(null, 'John Smith', false)).toBe(false);
    expect(isHumanSender('not-an-email', 'John Smith', false)).toBe(false);
    expect(isHumanSender('', 'John Smith', false)).toBe(false);
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
