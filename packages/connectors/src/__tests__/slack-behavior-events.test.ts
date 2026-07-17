import { describe, expect, test } from 'bun:test';
import {
  normalizeSlackBehaviorSignals,
  parseSlackUserMessageEvent,
} from '../slack-behavior-events';

const contentType = 'application/json';

describe('Slack Behavior events', () => {
  test('uses the user message as Behavior turn input', () => {
    const [signal] = normalizeSlackBehaviorSignals({
      deliveryId: 'body-hash-1',
      contentType,
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'app_mention',
          channel: 'C123',
          user: 'U123',
          text: 'Please review this.',
          ts: '171.001',
        },
      }),
    });

    expect(signal).toMatchObject({
      connector_key: 'slack',
      event_type: 'message.created',
      input_text: 'Please review this.',
      resource_ref: 'slack:channel:T123:C123',
      attributes: {
        channel_id: 'C123',
        user_id: 'U123',
        is_mention: true,
        message_id: '171.001',
      },
    });
  });

  test('normalizes ordinary channel messages for opt-in Listen behaviors', () => {
    const [signal] = normalizeSlackBehaviorSignals({
      deliveryId: 'body-hash-2',
      contentType,
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel_type: 'channel',
          channel: 'C123',
          user: 'U123',
          text: 'channel chatter',
        },
      }),
    });

    expect(signal.attributes).toMatchObject({
      channel_id: 'C123',
      channel_type: 'channel',
      is_mention: false,
    });
    // The old unclaimed-workspace response remains narrower: only mentions/DMs.
    expect(
      parseSlackUserMessageEvent(
        JSON.stringify({
          type: 'event_callback',
          event: {
            type: 'message',
            channel_type: 'channel',
            channel: 'C123',
            user: 'U123',
          },
        }),
        contentType,
      ),
    ).toBeNull();
  });

  test('drops bot messages, subtypes, form payloads, and challenges', () => {
    const bodies = [
      {
        type: 'event_callback',
        event: { type: 'message', channel: 'C', user: 'U', bot_id: 'B' },
      },
      {
        type: 'event_callback',
        event: {
          type: 'message',
          channel: 'C',
          user: 'U',
          subtype: 'message_changed',
        },
      },
      { type: 'url_verification', challenge: 'abc' },
    ];
    for (const body of bodies) {
      expect(
        normalizeSlackBehaviorSignals({
          deliveryId: 'delivery',
          contentType,
          body: JSON.stringify(body),
        }),
      ).toEqual([]);
    }
    expect(
      normalizeSlackBehaviorSignals({
        deliveryId: 'delivery',
        contentType: 'application/x-www-form-urlencoded',
        body: 'payload=%7B%7D',
      }),
    ).toEqual([]);
  });
});
