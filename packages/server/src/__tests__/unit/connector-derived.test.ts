import { describe, expect, test } from 'bun:test';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import {
  deriveBehaviorEventCatalogFromFeeds,
  deriveConnectorActivationSignals,
  resolveBehaviorEventCatalog,
  type ConnectorDeriveEventInput,
  type ConnectorDeriveFeedContext,
} from '../../behaviors/connector-derived';

const context: ConnectorDeriveFeedContext = {
  connectorKey: 'x',
  feedPreviouslySynced: true,
  eventKinds: { tweet: { description: 'A tweet' }, dm_message: {} },
};

const baseEvent: ConnectorDeriveEventInput = {
  connectionId: 7,
  originId: '2083959735481716957',
  kind: 'tweet',
  title: 'someone: hello',
  payloadText: 'hello from the home timeline',
  sourceUrl: 'https://x.com/someone/status/2083959735481716957',
  occurredAt: '2026-08-11T10:00:00.000Z',
  metadata: {
    author_handle: 'someone',
    reply_count: 3,
    nested: { deep: true },
  },
};

describe('deriveConnectorActivationSignals', () => {
  test('fires on an inserted event for a declared kind with a prior sync', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      baseEvent,
      'inserted', 123,
    );
    expect(signals).toHaveLength(1);
    const signal = signals[0] as ConnectorTriggerSignal;
    expect(signal.connector_key).toBe('x');
    expect(signal.connection_id).toBe(7);
    expect(signal.event_type).toBe('tweet');
    expect(signal.resource_type).toBe('tweet');
    expect(signal.resource_ref).toBe(baseEvent.originId);
    expect(signal.delivery_id).toBe('derived:x:7:event:123');
    expect(signal.label).toBe(baseEvent.title);
    expect(signal.input_text).toBe(baseEvent.payloadText);
    expect(signal.url).toBe(baseEvent.sourceUrl);
    expect(signal.occurred_at).toBe('2026-08-11T10:00:00.000Z');
    expect(signal.attributes).toEqual({
      change: 'inserted',
      author_handle: 'someone',
      reply_count: 3,
    });
  });

  test('suppresses a poll-driven cold-start batch before any successful sync', () => {
    const coldStart = { ...context, feedPreviouslySynced: false };
    expect(
      deriveConnectorActivationSignals(coldStart, baseEvent, 'inserted', 123),
    ).toEqual([]);
  });

  test('does not fire on superseded or unchanged rows', () => {
    expect(
      deriveConnectorActivationSignals(context, baseEvent, 'superseded', 123),
    ).toEqual([]);
    expect(
      deriveConnectorActivationSignals(context, baseEvent, 'unchanged', 123),
    ).toEqual([]);
  });

  test('does not fire for a kind the feed does not declare', () => {
    const undeclared = { ...baseEvent, kind: 'like' };
    expect(
      deriveConnectorActivationSignals(context, undeclared, 'inserted', 123),
    ).toEqual([]);
  });

  test('does not fire when the feed declares no eventKinds at all', () => {
    const noKinds = { ...context, eventKinds: null };
    expect(
      deriveConnectorActivationSignals(noKinds, baseEvent, 'inserted', 123),
    ).toEqual([]);
  });

  test('does not fire when the event is not a collected feed row', () => {
    const unconnected = { ...baseEvent, connectionId: null };
    expect(
      deriveConnectorActivationSignals(context, unconnected, 'inserted', 123),
    ).toEqual([]);
  });
});

describe('deriveBehaviorEventCatalogFromFeeds', () => {
  test('derives one subscribable type per declared kind', () => {
    const feeds = {
      home_feed: { eventKinds: { tweet: {}, dm_message: {} } },
      search: { eventKinds: { tweet: {}, thread: {} } },
    };
    const catalog = deriveBehaviorEventCatalogFromFeeds(feeds);
    expect(catalog.map((entry) => entry.key).sort()).toEqual([
      'dm_message',
      'thread',
      'tweet',
    ]);
  });

  test('returns [] for no feeds or no eventKinds', () => {
    expect(deriveBehaviorEventCatalogFromFeeds(null)).toEqual([]);
    expect(deriveBehaviorEventCatalogFromFeeds({ home_feed: {} })).toEqual([]);
    expect(deriveBehaviorEventCatalogFromFeeds({})).toEqual([]);
  });
});

describe('resolveBehaviorEventCatalog', () => {
  test('preserves every declared event field the UI editor reads', () => {
    const declared = [
      {
        key: 'message.created',
        label: 'A message is sent',
        description: 'Runs for messages in the selected scope.',
        resourceType: 'channel',
        filterSchema: { type: 'object', properties: { channel_id: { type: 'string' } } },
        defaults: { execution: 'turn', activeRun: 'steer', output: 'reply_to_source' },
        capabilities: { steering: true, replyToSource: true },
      },
    ];
    const resolved = resolveBehaviorEventCatalog({
      persistedEvents: declared,
      feedsSchema: {},
      bundled: null,
      useBundledFallback: false,
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      key: 'message.created',
      label: 'A message is sent',
      description: 'Runs for messages in the selected scope.',
      resourceType: 'channel',
      filterSchema: { type: 'object' },
      defaults: { execution: 'turn', activeRun: 'steer', output: 'reply_to_source' },
      capabilities: { steering: true, replyToSource: true },
    });
  });

  test('preserves null metadata as a matchable attribute value', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      { ...baseEvent, metadata: { assignee: null, nested: { deep: true } } },
      'inserted', 123,
    );
    expect(signals[0]?.attributes).toEqual({
      change: 'inserted',
      assignee: null,
    });
  });

  test('falls back to the title for a blank payload_text', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      { ...baseEvent, payloadText: '', title: 'Ask HN: Show your tools' },
      'inserted', 123,
    );
    expect(signals[0]?.input_text).toBe('Ask HN: Show your tools');
  });

  test('label never goes blank even for a blank title', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      { ...baseEvent, title: '', payloadText: 'body only' },
      'inserted', 123,
    );
    expect(signals[0]?.label).toBe('x tweet');
  });

  test('overlong kinds are skipped, never truncated, in catalog and signal', () => {
    const longKindA = 'a'.repeat(150);
    const longKindB = 'a'.repeat(130) + 'b';
    // Distinct long kinds sharing a prefix must NOT collapse into one type.
    const catalog = deriveBehaviorEventCatalogFromFeeds({
      home_feed: { eventKinds: { [longKindA]: {}, [longKindB]: {} } },
    });
    expect(catalog).toEqual([]);
    const signals = deriveConnectorActivationSignals(
      { ...context, eventKinds: { [longKindA]: {}, [longKindB]: {} } },
      { ...baseEvent, kind: longKindA },
      'inserted', 123,
    );
    expect(signals).toEqual([]);
  });

  test('caps derived fields to the connector-signal schema limits', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      {
        ...baseEvent,
        payloadText: 'x'.repeat(33_000),
        title: 't'.repeat(400),
        sourceUrl: 'u'.repeat(2_500),
        originId: 'o'.repeat(600),
        metadata: {
          [String('k').repeat(120)]: 'v',
          long_value: String('v').repeat(1_200),
        },
      },
      'inserted', 123,
    );
    const signal = signals[0] as ConnectorTriggerSignal;
    expect(signal.input_text.length).toBe(32_000);
    expect(signal.label.length).toBe(300);
    expect(signal.url?.length).toBe(2_000);
    // Overlong origin_id is omitted (not truncated) so identities cannot collide.
    expect(signal.resource_ref).toBeUndefined();
    expect(signal.resource_type?.length).toBeLessThanOrEqual(100);
    expect(signal.attributes?.long_value).toBe('v'.repeat(1_000));
    expect(signal.attributes?.[String('k').repeat(120)]).toBeUndefined();
  });

  test('an org override with a null feedsSchema never borrows the bundled feeds', () => {
    const resolved = resolveBehaviorEventCatalog({
      persistedEvents: null,
      feedsSchema: null,
      bundled: {
        feeds_schema: {
          pulls: { eventKinds: { pull_request: {} } },
        },
        behavior_events: null,
      },
      useBundledFallback: false,
    });
    expect(resolved).toEqual([]);
  });
});
