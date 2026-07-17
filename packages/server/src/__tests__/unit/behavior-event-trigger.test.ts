import { describe, expect, test } from 'bun:test';
import type { BehaviorEventTrigger } from '@lobu/core/contracts/tools/manage-behaviors';
import { normalizeSlackBehaviorSignals } from '@lobu/connectors/slack-behavior-events';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import { matchingBehaviorTriggers } from '../../behaviors/event-trigger';

const githubTrigger: BehaviorEventTrigger = {
  kind: 'event',
  connector_key: 'github',
  connection_id: 42,
  event_types: ['pull_request.created', 'state.merged'],
  match: { resource_ref: 'github:pull_request:lobu-ai/lobu#208' },
  execution: 'turn',
};

const slackTrigger: BehaviorEventTrigger = {
  kind: 'event',
  connector_key: 'slack',
  connection_id: 17,
  event_types: ['message.created'],
  match: { channel_id: 'C123' },
  execution: 'turn',
  active_run: 'steer',
};

describe('behavior event trigger matching', () => {
  test('matches a normalized GitHub signal against an ordinary Behavior trigger', () => {
    const githubSignal: ConnectorTriggerSignal = {
      connector_key: 'github',
      event_type: 'pull_request.created',
      delivery_id: 'delivery-1',
      input_text: 'GitHub PR lobu-ai/lobu#208: pull_request.created',
      resource_type: 'pull_request',
      resource_ref: 'github:pull_request:lobu-ai/lobu#208',
      attributes: { resource_ref: 'github:pull_request:lobu-ai/lobu#208' },
    };

    expect(
      matchingBehaviorTriggers([githubTrigger, slackTrigger], {
        ...githubSignal,
        connection_id: 42,
      }),
    ).toEqual([githubTrigger]);
  });

  test('matches Slack through the same path and keeps the message as agent input', () => {
    const [normalized] = normalizeSlackBehaviorSignals({
      deliveryId: 'Ev123',
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'app_mention',
          channel: 'C123',
          user: 'U123',
          text: 'Can you summarize this thread?',
          thread_ts: '171.001',
        },
      }),
    });
    const slackSignal: ConnectorTriggerSignal = {
      ...normalized,
      connection_id: 17,
    };

    expect(
      matchingBehaviorTriggers([githubTrigger, slackTrigger], slackSignal),
    ).toEqual([slackTrigger]);
    expect(slackSignal.input_text).toBe('Can you summarize this thread?');
  });

  test('fails closed across connections and normalized match fields', () => {
    const signal: ConnectorTriggerSignal = {
      connector_key: 'slack',
      connection_id: 99,
      event_type: 'message.created',
      delivery_id: 'Ev124',
      input_text: 'hello',
      attributes: { channel_id: 'C123' },
    };
    expect(matchingBehaviorTriggers([slackTrigger], signal)).toEqual([]);
  });
});
