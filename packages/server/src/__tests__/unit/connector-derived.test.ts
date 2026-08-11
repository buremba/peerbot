import { describe, expect, test } from 'bun:test';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import {
  deriveBehaviorEventCatalogFromFeeds,
  deriveConnectorActivationSignals,
  type ConnectorDeriveEventInput,
  type ConnectorDeriveFeedContext,
} from '../../behaviors/connector-derived';

const context: ConnectorDeriveFeedContext = {
  organizationId: 'org',
  connectorKey: 'x',
  feedKey: 'home_feed',
  feedCheckpointed: true,
  eventKinds: { tweet: { description: 'A tweet' }, dm_message: {} },
};

const baseEvent: ConnectorDeriveEventInput = {
  connectionId: 7,
  feedId: 9,
  runId: 100,
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
  test('fires on an inserted event for a declared kind with a checkpointed feed', () => {
    const signals = deriveConnectorActivationSignals(
      context,
      baseEvent,
      'inserted',
      123,
    );
    expect(signals).toHaveLength(1);
    const signal = signals[0] as ConnectorTriggerSignal;
    expect(signal.connector_key).toBe('x');
    expect(signal.connection_id).toBe(7);
    expect(signal.event_type).toBe('tweet');
    expect(signal.resource_type).toBe('tweet');
    expect(signal.resource_ref).toBe(baseEvent.originId);
    expect(signal.delivery_id).toBe('sync:100:event:123:derived');
    expect(signal.label).toBe(baseEvent.title);
    expect(signal.input_text).toBe(baseEvent.payloadText);
    expect(signal.url).toBe(baseEvent.sourceUrl);
    expect(signal.occurred_at).toBe('2026-08-11T10:00:00.000Z');
    expect(signal.attributes).toEqual({
      feed_key: 'home_feed',
      change: 'inserted',
      author_handle: 'someone',
      reply_count: 3,
    });
  });

  test('suppresses a poll-driven cold-start batch before the first successful sync', () => {
    const coldStart = { ...context, feedCheckpointed: false };
    expect(
      deriveConnectorActivationSignals(coldStart, baseEvent, 'inserted', 123),
    ).toEqual([]);
  });

  test('never suppresses webhook-STORE delivery, even without a checkpoint', () => {
    const coldStart = { ...context, feedCheckpointed: false };
    const storeEvent = { ...baseEvent, runId: null };
    const signals = deriveConnectorActivationSignals(
      coldStart,
      storeEvent,
      'inserted',
      456,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].delivery_id).toBe('store:x:7:2083959735481716957');
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
    const unconnected = { ...baseEvent, connectionId: null, feedId: null };
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
