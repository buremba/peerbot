/**
 * Integration tests for the durable chat transcript (`channel_messages`):
 * idempotent capture (dedup of webhook redelivery / bot echo) and the
 * connection-scoped, time-ordered read that backs read_conversation.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  persistChannelMessage,
  readChannelTranscript,
} from '../../../gateway/connections/channel-transcript';

function msg(overrides: Partial<Parameters<typeof persistChannelMessage>[0]> = {}) {
  return {
    organizationId: 'org-1',
    connectionId: 'conn-1',
    platform: 'slack',
    channelId: 'C0LUNCH',
    threadId: null,
    platformMessageId: '1718000000.0001',
    authorId: 'U_ALICE',
    authorName: 'Alice',
    isBot: false,
    text: 'I want a burrito',
    occurredAt: new Date('2026-06-18T11:00:00Z'),
    ...overrides,
  };
}

describe('channel transcript', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('persists a message and reads it back', async () => {
    await persistChannelMessage(msg());
    const out = await readChannelTranscript('org-1', 'conn-1', 'C0LUNCH', 50);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ user: 'Alice', text: 'I want a burrito', isBot: false });
  });

  it('is idempotent: same (connection, channel, platform_message_id) collapses to one row', async () => {
    await persistChannelMessage(msg());
    await persistChannelMessage(msg({ text: 'redelivered copy' })); // same id
    const out = await readChannelTranscript('org-1', 'conn-1', 'C0LUNCH', 50);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('I want a burrito'); // first write wins
  });

  it('returns messages oldest-first, capped at limit', async () => {
    for (let i = 0; i < 5; i++) {
      await persistChannelMessage(
        msg({
          platformMessageId: `ts-${i}`,
          text: `m${i}`,
          occurredAt: new Date(`2026-06-18T11:0${i}:00Z`),
        })
      );
    }
    const out = await readChannelTranscript('org-1', 'conn-1', 'C0LUNCH', 3);
    // newest 3, returned oldest-first
    expect(out.map((m) => m.text)).toEqual(['m2', 'm3', 'm4']);
  });

  it('is connection-scoped: another connection cannot read these messages', async () => {
    await persistChannelMessage(msg({ connectionId: 'conn-A' }));
    // Same channel id, different connection — must not leak.
    expect(await readChannelTranscript('org-1', 'conn-B', 'C0LUNCH', 50)).toEqual([]);
  });

  it('is org-scoped: another org sharing the same preview connection+channel cannot read these messages', async () => {
    // Two orgs bind the SAME physical channel through the shared hosted-preview
    // connection. Capture tags each row with the binding's routing org; a read
    // by the other org must NOT surface them, even though connection+channel match.
    await persistChannelMessage(msg({ organizationId: 'org-A' }));
    expect(
      await readChannelTranscript('org-B', 'conn-1', 'C0LUNCH', 50)
    ).toEqual([]);
    // The owning org still reads its own rows.
    expect(
      await readChannelTranscript('org-A', 'conn-1', 'C0LUNCH', 50)
    ).toHaveLength(1);
  });

  it('captures the bot\'s own posts (is_bot) so the transcript shows both sides', async () => {
    await persistChannelMessage(msg({ platformMessageId: 'u1', text: 'hi' }));
    await persistChannelMessage(
      msg({
        platformMessageId: 'b1',
        text: 'ordering from Chipotle',
        isBot: true,
        authorName: 'food-ordering',
        occurredAt: new Date('2026-06-18T11:05:00Z'),
      })
    );
    const out = await readChannelTranscript('org-1', 'conn-1', 'C0LUNCH', 50);
    expect(out.map((m) => [m.text, m.isBot])).toEqual([
      ['hi', false],
      ['ordering from Chipotle', true],
    ]);
  });

  it('normalizes the platform-prefixed channel id so a native-id read matches', async () => {
    // Inbound capture passes the prefixed form (`telegram:123`); the conversation
    // tools read with the stripped native id (`123`). persist must normalize so
    // the two ends agree — else read_conversation silently returns nothing.
    await persistChannelMessage(
      msg({ platform: 'telegram', channelId: 'telegram:6570514069' })
    );
    const out = await readChannelTranscript(
      'org-1',
      'conn-1',
      '6570514069',
      50
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('I want a burrito');
  });

  it('skips empty/whitespace text', async () => {
    await persistChannelMessage(msg({ text: '   ' }));
    expect(await readChannelTranscript('org-1', 'conn-1', 'C0LUNCH', 50)).toEqual([]);
  });
});
