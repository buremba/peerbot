import { describe, expect, test } from 'bun:test';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';
import type {
  AutomationEventTrigger,
  AutomationWorkspaceEventTrigger,
} from '@lobu/core/contracts/tools/manage-automations';
import { matchingAutomationTriggers } from '../../automations/event-trigger';
import {
  assertAutomationOutputsUseWindowExecution,
  normalizeAutomationTriggers,
} from '../../automations/triggers';
import { matchesWorkspaceEventTrigger } from '../../automations/workspace-event';
import {
  deriveWorkspaceEventCausality,
  MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS,
} from '../../automations/workspace-event-contract';

const githubTrigger: AutomationEventTrigger = {
  kind: 'event',
  connector_key: 'github',
  connection_id: 42,
  event_types: ['pull_request.created', 'state.merged'],
  match: { resource_ref: 'github:pull_request:lobu-ai/lobu#208' },
  execution: 'turn',
};

const slackTrigger: AutomationEventTrigger = {
  kind: 'event',
  connector_key: 'slack',
  connection_id: 17,
  event_types: ['message.created'],
  match: { channel_id: 'C123' },
  execution: 'turn',
  active_run: 'steer',
  output: 'reply_to_source',
};

describe('automation event trigger matching', () => {
  test('matches a normalized GitHub signal against an ordinary Automation trigger', () => {
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
      matchingAutomationTriggers([githubTrigger, slackTrigger], {
        ...githubSignal,
        connection_id: 42,
      }),
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
      matchingAutomationTriggers([githubTrigger, slackTrigger], slackSignal),
    ).toEqual([slackTrigger]);
    expect(slackSignal.input_text).toBe('Can you summarize this thread?');
  });

  test('treats a stored team_id as delivery metadata, not a routing predicate', () => {
    const teamScopedTrigger: AutomationEventTrigger = {
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
      matchingAutomationTriggers([teamScopedTrigger], {
        ...baseSignal,
        attributes: { ...baseSignal.attributes, team_id: 'T_THEIRS' },
      }),
    ).toEqual([teamScopedTrigger]);
    // Payloads that omit team entirely must still route.
    expect(matchingAutomationTriggers([teamScopedTrigger], baseSignal)).toEqual([
      teamScopedTrigger,
    ]);
    // Channel identity still gates.
    expect(
      matchingAutomationTriggers([teamScopedTrigger], {
        ...baseSignal,
        attributes: { ...baseSignal.attributes, channel_id: 'C999' },
      }),
    ).toEqual([]);
  });

  test('returns every matching event trigger in array order (multi-trigger OR)', () => {
    const broad: AutomationEventTrigger = {
      ...githubTrigger,
      match: undefined,
      execution: 'window',
      output: 'silent',
    };
    const specific: AutomationEventTrigger = {
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
    expect(matchingAutomationTriggers([broad, specific], signal)).toEqual([
      broad,
      specific,
    ]);
    expect(matchingAutomationTriggers([specific, broad], signal)[0]).toBe(
      specific,
    );
  });

  test('rejects more than one schedule trigger on write', () => {
    expect(() =>
      normalizeAutomationTriggers([
        { kind: 'schedule', cron: '0 9 * * *' },
        { kind: 'schedule', cron: '0 18 * * *' },
      ]),
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
    expect(matchingAutomationTriggers([slackTrigger], signal)).toEqual([]);
  });

  test('mention_only:false is unfiltered (unchecked checkbox), not "only non-mentions"', () => {
    const falseFilter: AutomationEventTrigger = {
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
    expect(matchingAutomationTriggers([falseFilter], mentionSignal)).toEqual([
      falseFilter,
    ]);
    expect(matchingAutomationTriggers([falseFilter], plainSignal)).toEqual([
      falseFilter,
    ]);

    // Write-time: false is stripped so the stored match is sparse.
    const normalized = normalizeAutomationTriggers([falseFilter]);
    expect(normalized[0]).toMatchObject({
      kind: 'event',
      source: 'connector',
      match: { channel_id: 'C123' },
    });
    expect(
      (normalized[0] as AutomationEventTrigger).match,
    ).not.toHaveProperty('mention_only');
  });

  test('mention_only:true still requires a mention signal', () => {
    const mentionOnly: AutomationEventTrigger = {
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

    expect(matchingAutomationTriggers([mentionOnly], mentionSignal)).toEqual([
      mentionOnly,
    ]);
    expect(matchingAutomationTriggers([mentionOnly], plainSignal)).toEqual([]);
  });

  test('rejects unsupported execution, output, and active-run combinations', () => {
    expect(() =>
      normalizeAutomationTriggers([
        {
          ...slackTrigger,
          execution: 'window',
          active_run: 'steer',
          output: 'silent',
        },
      ]),
    ).toThrow('Window execution does not support steering');
    expect(() =>
      normalizeAutomationTriggers([
        {
          ...slackTrigger,
          execution: 'window',
          active_run: 'coalesce',
          output: 'reply_to_source',
        },
      ]),
    ).toThrow('Window execution cannot reply to the source');
    expect(() =>
      normalizeAutomationTriggers([
        {
          ...slackTrigger,
          execution: 'turn',
          active_run: 'steer',
          output: 'silent',
        },
      ]),
    ).toThrow('Steering requires a turn that replies to the source');
  });

  test('requires window execution when an Automation declares durable outputs', () => {
    expect(() =>
      assertAutomationOutputsUseWindowExecution([githubTrigger], {
        observations: { event: 'observation' },
      })
    ).toThrow(/outputs require window execution/i);

    expect(() =>
      assertAutomationOutputsUseWindowExecution(
        [{ ...githubTrigger, execution: 'window' }],
        { observations: { event: 'observation' } }
      )
    ).not.toThrow();
    expect(() =>
      assertAutomationOutputsUseWindowExecution([githubTrigger], null)
    ).not.toThrow();
  });

  test('matches workspace events by semantic type, entity type, and exact metadata', () => {
    const trigger: AutomationWorkspaceEventTrigger = {
      kind: 'event',
      source: 'workspace',
      entity_type: 'account',
      event_types: ['risk_detected'],
      match: { severity: 'high', reviewed: false },
    };
    const event = {
      semanticType: 'risk_detected',
      auditEventType: null,
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

  test('matches platform audit rows by stamped type or by semantic type', () => {
    // Every audit row shares the `change` semantic type, so the stamp is the
    // only way to name one kind of change. Both names must work: dropping the
    // semantic arm would silently unsubscribe anyone already listening to
    // `change`, and dropping the stamped arm is the whole point of the stamp.
    const auditRow = {
      semanticType: 'change',
      auditEventType: 'device.online',
      entityTypeSlugs: [] as string[],
      metadata: {},
    };
    const bySubject = {
      kind: 'event',
      source: 'workspace',
      event_types: ['device.online'],
    } satisfies AutomationWorkspaceEventTrigger;
    const bySemanticType = {
      kind: 'event',
      source: 'workspace',
      event_types: ['change'],
    } satisfies AutomationWorkspaceEventTrigger;
    expect(matchesWorkspaceEventTrigger(bySubject, auditRow)).toBe(true);
    expect(matchesWorkspaceEventTrigger(bySemanticType, auditRow)).toBe(true);
    expect(
      matchesWorkspaceEventTrigger(
        {
          kind: 'event',
          source: 'workspace',
          event_types: ['device.offline'],
        },
        auditRow
      )
    ).toBe(false);
    // A plain Automation output carries no stamp, so a `<subject>.<op>`
    // subscription must not pick it up on the semantic arm alone.
    expect(
      matchesWorkspaceEventTrigger(bySubject, {
        ...auditRow,
        auditEventType: null,
      })
    ).toBe(false);
  });

  test('an audit row still honors entity-type and metadata narrowing', () => {
    const trigger: AutomationWorkspaceEventTrigger = {
      kind: 'event',
      source: 'workspace',
      entity_type: 'account',
      event_types: ['entity.updated'],
      match: { field: 'owner' },
    };
    const event = {
      semanticType: 'change',
      auditEventType: 'entity.updated',
      entityTypeSlugs: ['account'],
      metadata: { field: 'owner' },
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
        metadata: { field: 'stage' },
      })
    ).toBe(false);
  });

  test('defaults workspace-event analysis to coalesced windows', () => {
    expect(
      normalizeAutomationTriggers([
        {
          kind: 'event',
          source: 'workspace',
          event_types: ['risk_detected'],
        },
      ])
    ).toEqual([
      {
        kind: 'event',
        source: 'workspace',
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
      kind: 'event' as const,
      source: 'workspace' as const,
      event_id: 40,
      event_type: 'risk_detected',
      delivery_id: 'workspace-event:40',
      occurred_at: '2026-08-11T00:00:00.000Z',
      root_event_ids: [40],
      causal_automation_ids: [7],
      depth: 1,
    };
    expect(deriveWorkspaceEventCausality([signal, signal], 9)).toEqual({
      rootEventIds: [40],
      causalAutomationIds: [7, 9],
      depth: 2,
    });
  });

  test('preserves a producer already present in its inherited causal path', () => {
    expect(
      deriveWorkspaceEventCausality(
        [
          {
            kind: 'event',
            source: 'workspace',
            event_id: 40,
            event_type: 'risk_detected',
            delivery_id: 'workspace-event:40',
            occurred_at: '2026-08-11T00:00:00.000Z',
            root_event_ids: [40],
            causal_automation_ids: [7, 9],
            depth: 2,
          },
        ],
        9
      )
    ).toEqual({
      rootEventIds: [40],
      causalAutomationIds: [7, 9],
      depth: 3,
    });
  });

  test('measures causal depth by hops when coalescing independent branches', () => {
    const signal = (root: number, ancestor: number) => ({
      kind: 'event' as const,
      source: 'workspace' as const,
      event_id: root,
      event_type: 'risk_detected',
      delivery_id: `workspace-event:${root}`,
      occurred_at: '2026-08-11T00:00:00.000Z',
      root_event_ids: [root],
      causal_automation_ids: [7, ancestor],
      depth: 2,
    });
    expect(
      deriveWorkspaceEventCausality([signal(40, 8), signal(41, 10)], 12)
    ).toEqual({
      rootEventIds: [40, 41],
      causalAutomationIds: [7, 8, 10, 12],
      depth: 3,
    });
  });

  test('bounds the inherited causal set carried by a durable signal', () => {
    const causalAutomationIds = Array.from(
      { length: MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS },
      (_, index) => index + 1
    );
    expect(() =>
      deriveWorkspaceEventCausality(
        [
          {
            kind: 'event',
            source: 'workspace',
            event_id: 40,
            event_type: 'risk_detected',
            delivery_id: 'workspace-event:40',
            occurred_at: '2026-08-11T00:00:00.000Z',
            root_event_ids: [40],
            causal_automation_ids: causalAutomationIds,
            depth: 2,
          },
        ],
        MAX_WORKSPACE_EVENT_CAUSAL_AUTOMATIONS + 1
      )
    ).toThrow(/causality exceeds/i);
  });
});
