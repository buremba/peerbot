import { describe, expect, test } from 'bun:test';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import type {
  BehaviorEventTrigger,
  BehaviorWorkspaceEventTrigger,
} from '@lobu/core/contracts/tools/manage-behaviors';
import { matchingBehaviorTriggers } from '../../behaviors/event-trigger';
import {
  assertBehaviorOutputsUseWindowExecution,
  normalizeBehaviorTriggers,
} from '../../behaviors/triggers';
import {
  deriveWorkspaceEventCausality,
  MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS,
  matchesWorkspaceEventTrigger,
} from '../../behaviors/workspace-event';

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
  output: 'reply_to_source',
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
      })
    ).toEqual([githubTrigger]);
  });

  test('matches Slack through the same path and keeps the message as agent input', () => {
    const slackSignal: ConnectorTriggerSignal = {
      connector_key: 'slack',
      connection_id: 17,
      resource_type: 'channel',
      resource_ref: 'slack:channel:T123:C123',
      event_type: 'message.created',
      delivery_id: 'Ev123',
      input_text: 'Can you summarize this thread?',
      label: 'Slack message in C123',
      attributes: {
        channel_id: 'C123',
        team_id: 'T123',
        user_id: 'U123',
        is_mention: true,
        thread_id: '171.001',
      },
    };

    expect(
      matchingBehaviorTriggers([githubTrigger, slackTrigger], slackSignal)
    ).toEqual([slackTrigger]);
    expect(slackSignal.input_text).toBe('Can you summarize this thread?');
  });

  test('treats a stored team_id as delivery metadata, not a routing predicate', () => {
    const teamScopedTrigger: BehaviorEventTrigger = {
      ...slackTrigger,
      match: { channel_id: 'C123', team_id: 'T_OURS' },
    };
    const baseSignal: ConnectorTriggerSignal = {
      connector_key: 'slack',
      connection_id: 17,
      resource_type: 'channel',
      event_type: 'message.created',
      delivery_id: 'Ev200',
      input_text: 'hello from a partner workspace',
      attributes: { channel_id: 'C123', user_id: 'U9' },
    };

    // Slack Connect: the author's workspace id differs from the stored team.
    expect(
      matchingBehaviorTriggers([teamScopedTrigger], {
        ...baseSignal,
        attributes: { ...baseSignal.attributes, team_id: 'T_THEIRS' },
      })
    ).toEqual([teamScopedTrigger]);
    // Payloads that omit team entirely must still route.
    expect(matchingBehaviorTriggers([teamScopedTrigger], baseSignal)).toEqual([
      teamScopedTrigger,
    ]);
    // Channel identity still gates.
    expect(
      matchingBehaviorTriggers([teamScopedTrigger], {
        ...baseSignal,
        attributes: { ...baseSignal.attributes, channel_id: 'C999' },
      })
    ).toEqual([]);
  });

  test('returns every matching event trigger in array order (multi-trigger OR)', () => {
    const broad: BehaviorEventTrigger = {
      ...githubTrigger,
      match: undefined,
      execution: 'window',
      output: 'silent',
    };
    const specific: BehaviorEventTrigger = {
      ...githubTrigger,
      execution: 'turn',
      output: 'reply_to_source',
    };
    const signal: ConnectorTriggerSignal = {
      connector_key: 'github',
      connection_id: 42,
      event_type: 'pull_request.created',
      delivery_id: 'delivery-multi',
      input_text: 'GitHub PR',
      resource_type: 'pull_request',
      resource_ref: 'github:pull_request:lobu-ai/lobu#208',
      attributes: { resource_ref: 'github:pull_request:lobu-ai/lobu#208' },
    };
    // First match wins for activation policy; matching itself keeps full order.
    expect(matchingBehaviorTriggers([broad, specific], signal)).toEqual([
      broad,
      specific,
    ]);
    expect(matchingBehaviorTriggers([specific, broad], signal)[0]).toBe(
      specific
    );
  });

  test('rejects more than one schedule trigger on write', () => {
    expect(() =>
      normalizeBehaviorTriggers([
        { kind: 'schedule', cron: '0 9 * * *' },
        { kind: 'schedule', cron: '0 18 * * *' },
      ])
    ).toThrow(/at most one schedule/i);
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

  test('mention_only:false is unfiltered (unchecked checkbox), not "only non-mentions"', () => {
    const falseFilter: BehaviorEventTrigger = {
      ...slackTrigger,
      match: { channel_id: 'C123', mention_only: false },
    };
    const mentionSignal: ConnectorTriggerSignal = {
      connector_key: 'slack',
      connection_id: 17,
      resource_type: 'channel',
      event_type: 'message.created',
      delivery_id: 'Ev-mention',
      input_text: '@bot hi',
      attributes: {
        channel_id: 'C123',
        is_mention: true,
        mention_only: true,
      },
    };
    const plainSignal: ConnectorTriggerSignal = {
      ...mentionSignal,
      delivery_id: 'Ev-plain',
      input_text: 'plain chatter',
      attributes: {
        channel_id: 'C123',
        is_mention: false,
        mention_only: false,
      },
    };

    // Match-time: already-stored false must not invert.
    expect(matchingBehaviorTriggers([falseFilter], mentionSignal)).toEqual([
      falseFilter,
    ]);
    expect(matchingBehaviorTriggers([falseFilter], plainSignal)).toEqual([
      falseFilter,
    ]);

    // Write-time: false is stripped so the stored match is sparse.
    const normalized = normalizeBehaviorTriggers([falseFilter]);
    expect(normalized[0]).toMatchObject({
      kind: 'event',
      match: { channel_id: 'C123' },
    });
    expect((normalized[0] as BehaviorEventTrigger).match).not.toHaveProperty(
      'mention_only'
    );
  });

  test('mention_only:true still requires a mention signal', () => {
    const mentionOnly: BehaviorEventTrigger = {
      ...slackTrigger,
      match: { channel_id: 'C123', mention_only: true },
    };
    const mentionSignal: ConnectorTriggerSignal = {
      connector_key: 'slack',
      connection_id: 17,
      resource_type: 'channel',
      event_type: 'message.created',
      delivery_id: 'Ev-m',
      input_text: '@bot hi',
      attributes: {
        channel_id: 'C123',
        is_mention: true,
        mention_only: true,
      },
    };
    const plainSignal: ConnectorTriggerSignal = {
      ...mentionSignal,
      delivery_id: 'Ev-p',
      attributes: {
        channel_id: 'C123',
        is_mention: false,
        mention_only: false,
      },
    };

    expect(matchingBehaviorTriggers([mentionOnly], mentionSignal)).toEqual([
      mentionOnly,
    ]);
    expect(matchingBehaviorTriggers([mentionOnly], plainSignal)).toEqual([]);
  });

  test('rejects unsupported execution, output, and active-run combinations', () => {
    expect(() =>
      normalizeBehaviorTriggers([
        {
          ...slackTrigger,
          execution: 'window',
          active_run: 'steer',
          output: 'silent',
        },
      ])
    ).toThrow('Window execution does not support steering');
    expect(() =>
      normalizeBehaviorTriggers([
        {
          ...slackTrigger,
          execution: 'window',
          active_run: 'coalesce',
          output: 'reply_to_source',
        },
      ])
    ).toThrow('Window execution cannot reply to the source');
    expect(() =>
      normalizeBehaviorTriggers([
        {
          ...slackTrigger,
          execution: 'turn',
          active_run: 'steer',
          output: 'silent',
        },
      ])
    ).toThrow('Steering requires a turn that replies to the source');
  });

  test('requires window execution when a Behavior declares durable outputs', () => {
    expect(() =>
      assertBehaviorOutputsUseWindowExecution([githubTrigger], {
        observations: { event: 'observation' },
      })
    ).toThrow(/outputs require window execution/i);

    expect(() =>
      assertBehaviorOutputsUseWindowExecution(
        [{ ...githubTrigger, execution: 'window' }],
        { observations: { event: 'observation' } }
      )
    ).not.toThrow();
    expect(() =>
      assertBehaviorOutputsUseWindowExecution([githubTrigger], null)
    ).not.toThrow();
  });

  test('matches workspace events by semantic type, entity type, and exact metadata', () => {
    const trigger: BehaviorWorkspaceEventTrigger = {
      kind: 'workspace_event',
      entity_type: 'account',
      event_types: ['risk_detected'],
      match: { severity: 'high', reviewed: false },
    };
    const event = {
      semanticType: 'risk_detected',
      entityTypeSlugs: ['account'],
      metadata: { severity: 'high', reviewed: false, score: 92 },
    };
    expect(matchesWorkspaceEventTrigger(trigger, event)).toBe(true);
    expect(
      matchesWorkspaceEventTrigger(trigger, {
        ...event,
        entityTypeSlugs: ['contact'],
      })
    ).toBe(false);
    expect(
      matchesWorkspaceEventTrigger(trigger, {
        ...event,
        metadata: { ...event.metadata, severity: 'low' },
      })
    ).toBe(false);
  });

  test('defaults workspace-event analysis to coalesced windows', () => {
    expect(
      normalizeBehaviorTriggers([
        { kind: 'workspace_event', event_types: ['risk_detected'] },
      ])
    ).toEqual([
      {
        kind: 'workspace_event',
        event_types: ['risk_detected'],
        entity_type: undefined,
        match: undefined,
        execution: 'window',
        active_run: 'coalesce',
      },
    ]);
  });

  test('extends causal ancestry once across coalesced workspace signals', () => {
    const signal = {
      kind: 'workspace_event' as const,
      event_id: 40,
      event_type: 'risk_detected',
      delivery_id: 'workspace-event:40',
      occurred_at: '2026-08-11T00:00:00.000Z',
      root_event_id: 40,
      causal_behavior_ids: [7],
      depth: 1,
    };
    expect(deriveWorkspaceEventCausality([signal, signal], 9)).toEqual({
      rootEventId: 40,
      causalBehaviorIds: [7, 9],
      depth: 2,
    });
  });

  test('measures causal depth by hops when coalescing independent branches', () => {
    const signal = (root: number, ancestor: number) => ({
      kind: 'workspace_event' as const,
      event_id: root,
      event_type: 'risk_detected',
      delivery_id: `workspace-event:${root}`,
      occurred_at: '2026-08-11T00:00:00.000Z',
      root_event_id: root,
      causal_behavior_ids: [7, ancestor],
      depth: 2,
    });
    expect(
      deriveWorkspaceEventCausality([signal(40, 8), signal(41, 10)], 12)
    ).toEqual({
      rootEventId: 40,
      causalBehaviorIds: [7, 8, 10, 12],
      depth: 3,
    });
  });

  test('bounds the inherited causal set carried by a durable signal', () => {
    const causalBehaviorIds = Array.from(
      { length: MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS },
      (_, index) => index + 1
    );
    expect(() =>
      deriveWorkspaceEventCausality(
        [
          {
            kind: 'workspace_event',
            event_id: 40,
            event_type: 'risk_detected',
            delivery_id: 'workspace-event:40',
            occurred_at: '2026-08-11T00:00:00.000Z',
            root_event_id: 40,
            causal_behavior_ids: causalBehaviorIds,
            depth: 2,
          },
        ],
        MAX_WORKSPACE_EVENT_CAUSAL_BEHAVIORS + 1
      )
    ).toThrow(/causality exceeds/i);
  });
});
