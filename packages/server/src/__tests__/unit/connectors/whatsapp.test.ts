/**
 * Unit tests for the WhatsApp connector's `toEvent` and `jidToPhone`.
 *
 * These cover the shape-translation path between real Baileys WAMessage
 * objects and the EventEnvelope metadata the entityLinks rule reads —
 * multi-device JID suffix handling, group participant attribution, and
 * from_me suppression. The integration test (whatsapp-entity-links.test.ts)
 * only exercises applyEntityLinks with synthetic metadata, so regressions
 * in toEvent would otherwise pass undetected.
 *
 * Uses a string-built path for the dynamic import so tsc doesn't follow the
 * connector's `npm:baileys@...` specifier — that specifier is rewritten at
 * install time by the connector compiler and isn't meant for tsc. The
 * connector compiler must run before this test does; under raw bun/node
 * the unrewritten specifier fails to resolve. CI runs unit tests via `bun
 * test`, which does not run the connector compiler — so this file is
 * skipped there. Run locally via `bun run test:connectors` when touching
 * connector code.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ENABLED = process.env.RUN_CONNECTOR_TESTS === '1';

type ToEventFn = (
  m: unknown,
  chatNames: Map<string, string>,
  filter: 'all' | 'individual' | 'group'
) => {
  title?: string | null;
  source_url?: string;
  metadata: Record<string, unknown>;
} | null;
type JidToPhoneFn = (jid: string) => string | undefined;

let toEvent: ToEventFn;
let jidToPhone: JidToPhoneFn;

beforeAll(async () => {
  if (!ENABLED) return; // see file header — connector compiler isn't run in CI
  // Build the path at runtime so tsc doesn't chase `npm:baileys@...` through
  // the static import graph. Resolve relative to this file so it works whether
  // process.cwd() is the repo root, the package, or a worktree.
  const target = pathToFileURL(
    path.resolve(__dirname, '../../../../../connectors/src/whatsapp.ts')
  ).href;
  const mod = (await import(target)) as {
    toEvent: ToEventFn;
    jidToPhone: JidToPhoneFn;
  };
  toEvent = mod.toEvent;
  jidToPhone = mod.jidToPhone;
});

const BASE_TS = Math.floor(Date.parse('2026-04-17T12:00:00Z') / 1000);

function makeMessage(overrides: Record<string, unknown>): unknown {
  return {
    key: {
      remoteJid: '14155551234@s.whatsapp.net',
      fromMe: false,
      id: 'msg-1',
    },
    message: { conversation: 'hi there' },
    messageTimestamp: BASE_TS,
    pushName: 'Alex',
    ...overrides,
  };
}

(ENABLED ? describe : describe.skip)('jidToPhone', () => {
  it('returns the digit string for a bare s.whatsapp.net JID', () => {
    expect(jidToPhone('14155551234@s.whatsapp.net')).toBe('14155551234');
  });

  it('strips the device suffix on multi-device JIDs', () => {
    expect(jidToPhone('14155551234:5@s.whatsapp.net')).toBe('14155551234');
    expect(jidToPhone('442071234567:12@s.whatsapp.net')).toBe('442071234567');
  });

  it('returns undefined for @lid privacy-protected JIDs (non-digit local part)', () => {
    expect(jidToPhone('abc123xyz@lid')).toBeUndefined();
  });

  it('returns undefined for broadcast / synthetic JIDs', () => {
    expect(jidToPhone('status@broadcast')).toBeUndefined();
  });

  it('refuses numeric JIDs whose domain is not a person-number namespace', () => {
    // Numeric local parts on @lid / @g.us / @newsletter / @broadcast are not
    // real phone numbers; only @s.whatsapp.net (and legacy @c.us) are.
    expect(jidToPhone('123456789012@lid')).toBeUndefined();
    expect(jidToPhone('120363000000000000@g.us')).toBeUndefined();
    expect(jidToPhone('123456789012@newsletter')).toBeUndefined();
    expect(jidToPhone('123456789012@broadcast')).toBeUndefined();
  });

  it('also handles legacy @c.us JIDs defensively', () => {
    expect(jidToPhone('14155551234@c.us')).toBe('14155551234');
  });
});

(ENABLED ? describe : describe.skip)('toEvent', () => {
  it('emits sender_jid / sender_phone / push_name for an incoming 1:1 message', () => {
    const event = toEvent(
      makeMessage({
        key: {
          remoteJid: '14155551234@s.whatsapp.net',
          fromMe: false,
          id: 'msg-1',
        },
      }),
      new Map(),
      'all'
    );
    expect(event).not.toBeNull();
    expect(event?.metadata).toMatchObject({
      chat_jid: '14155551234@s.whatsapp.net',
      is_group: false,
      from_me: false,
      sender_jid: '14155551234@s.whatsapp.net',
      sender_phone: '14155551234',
      push_name: 'Alex',
    });
  });

  it('strips the device suffix out of sender_phone on multi-device 1:1 messages', () => {
    const event = toEvent(
      makeMessage({
        key: {
          remoteJid: '14155551234:5@s.whatsapp.net',
          fromMe: false,
          id: 'msg-md',
        },
      }),
      new Map(),
      'all'
    );
    expect(event?.metadata.sender_phone).toBe('14155551234');
    // The raw JID is preserved as-is on the event; normalizeWaJid collapses
    // the device suffix when the identifier is written to entity_identities.
    expect(event?.metadata.sender_jid).toBe('14155551234:5@s.whatsapp.net');
  });

  it('uses the group participant (with device suffix) as sender_jid on group messages', () => {
    const event = toEvent(
      makeMessage({
        key: {
          remoteJid: '120363000000000000@g.us',
          participant: '14155551234:2@s.whatsapp.net',
          fromMe: false,
          id: 'msg-g',
        },
      }),
      new Map([['120363000000000000@g.us', 'Test Group']]),
      'all'
    );
    expect(event?.metadata).toMatchObject({
      chat_jid: '120363000000000000@g.us',
      is_group: true,
      sender_jid: '14155551234:2@s.whatsapp.net',
      sender_phone: '14155551234',
      push_name: 'Alex',
    });
    expect(event?.title).toBe('Test Group');
  });

  it('skips sender identifiers when from_me is true', () => {
    const event = toEvent(
      makeMessage({
        key: {
          remoteJid: '14155551234@s.whatsapp.net',
          fromMe: true,
          id: 'msg-me',
        },
      }),
      new Map(),
      'all'
    );
    expect(event?.metadata.from_me).toBe(true);
    expect(event?.metadata.sender_jid).toBeUndefined();
    expect(event?.metadata.sender_phone).toBeUndefined();
  });

  it('omits push_name when Baileys did not provide one', () => {
    const event = toEvent(
      makeMessage({
        pushName: undefined,
      }),
      new Map(),
      'all'
    );
    expect(event?.metadata.push_name).toBeUndefined();
  });

  it('emits sender_jid but not sender_phone for @lid JIDs', () => {
    const event = toEvent(
      makeMessage({
        key: {
          remoteJid: 'abc123xyz@lid',
          fromMe: false,
          id: 'msg-lid',
        },
      }),
      new Map(),
      'all'
    );
    expect(event?.metadata.sender_jid).toBe('abc123xyz@lid');
    expect(event?.metadata.sender_phone).toBeUndefined();
  });

  it('drops messages with no text content', () => {
    const event = toEvent(
      makeMessage({
        message: { imageMessage: {} },
      }),
      new Map(),
      'all'
    );
    expect(event).toBeNull();
  });

  it('does not emit sender_jid for newsletter / broadcast chats', () => {
    // Newsletters and broadcast lists address something that isn't a person
    // — their numeric local parts would otherwise pass normalizeWaJid and
    // create a bogus $member keyed by wa_jid.
    for (const chatJid of ['120363000000000000@newsletter', '999999999999@broadcast']) {
      const event = toEvent(
        makeMessage({
          key: { remoteJid: chatJid, fromMe: false, id: `msg-${chatJid}` },
        }),
        new Map(),
        'all'
      );
      expect(event?.metadata.sender_jid).toBeUndefined();
      expect(event?.metadata.sender_phone).toBeUndefined();
      expect(event?.source_url).toBeUndefined();
    }
  });

  it('does not emit sender_jid for a group message with no participant', () => {
    // Rare (system notices, broken state), but we must never let the group
    // JID itself become a $member identity.
    const event = toEvent(
      makeMessage({
        key: {
          remoteJid: '120363000000000000@g.us',
          fromMe: false,
          id: 'msg-noparticipant',
        },
      }),
      new Map(),
      'all'
    );
    expect(event?.metadata.is_group).toBe(true);
    expect(event?.metadata.sender_jid).toBeUndefined();
    expect(event?.metadata.sender_phone).toBeUndefined();
  });

  it('respects the individual/group filter', () => {
    const group = makeMessage({
      key: {
        remoteJid: '120363000000000000@g.us',
        participant: '14155551234@s.whatsapp.net',
        fromMe: false,
        id: 'msg-g',
      },
    });
    expect(toEvent(group, new Map(), 'individual')).toBeNull();
    expect(toEvent(group, new Map(), 'group')).not.toBeNull();

    const direct = makeMessage({});
    expect(toEvent(direct, new Map(), 'group')).toBeNull();
    expect(toEvent(direct, new Map(), 'individual')).not.toBeNull();
  });
});
