/**
 * Stage C: a platform-written audit row actually reaches its subscriber.
 *
 * #2938 taught the activation path to handle a root, and #2944 made the type
 * subscribable — but nothing enqueued, so a subscription could exist and never
 * fire. These tests cover the write path: an audit row with a subscribed
 * `<subject>.<op>` type queues an activation, and one produced by an Automation
 * names that Automation as its own causal path so it cannot wake itself.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';
import {
  insertConnectionlessAuditEvent,
  recordLifecycleEvent,
} from '../../../utils/insert-event';
import { runWithActingAutomation } from '../../../utils/acting-automation-context';
import { WORKSPACE_EVENT_ACTIVATION_TASK } from '../../../scheduled/task-definitions';
import { MAX_COALESCED_AUTOMATION_EVENT_INPUTS } from '../../../automations/workspace-event-contract';

interface QueuedActivation {
  organizationId: string;
  eventId: number;
  rootEventIds: number[];
  causalAutomationIds: number[];
  depth: number;
}

async function subscriber(name: string, eventTypes: string[]) {
  const workspace = await TestWorkspace.create({ name });
  const ownerUserId = workspace.users.owner.id;
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'platform-enqueue-agent',
  });
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });
  const created = (await api.automations.create({
    slug: 'platform-consumer',
    prompt: 'Handle the platform event.',
    triggers: [
      {
        kind: 'event',
        source: 'workspace',
        event_types: eventTypes,
        execution: 'window',
        active_run: 'queue',
      },
    ],
    agent_id: agent.agentId,
  })) as { automation_id: string };
  return {
    organizationId: workspace.org.id,
    automationId: Number(created.automation_id),
    api,
    agentId: agent.agentId,
  };
}

/** A second real Automation in the same org — `events.automation_id` has a FK. */
async function secondAutomation(
  api: Awaited<ReturnType<typeof subscriber>>['api'],
  agentId: string,
  slug: string
): Promise<number> {
  const created = (await api.automations.create({
    slug,
    prompt: 'Upstream automation.',
    agent_id: agentId,
  })) as { automation_id: string };
  return Number(created.automation_id);
}

/** Activation tasks queued for an org, newest last. */
async function queuedActivations(
  organizationId: string
): Promise<QueuedActivation[]> {
  const sql = getTestDb();
  const rows = await sql<{ action_input: { payload: QueuedActivation } }>`
    SELECT action_input
    FROM public.runs
    WHERE run_type = 'task'
      AND action_key = ${WORKSPACE_EVENT_ACTIVATION_TASK}
      AND organization_id = ${organizationId}
    ORDER BY id ASC
  `;
  return rows.map((row) => row.action_input.payload);
}

/**
 * `recordLifecycleEvent` is fire-and-forget, so the write and its enqueue both
 * settle after the call returns. Poll rather than sleep a fixed interval.
 */
async function waitForActivations(
  organizationId: string,
  count: number
): Promise<QueuedActivation[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const queued = await queuedActivations(organizationId);
    if (queued.length >= count) return queued;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return queuedActivations(organizationId);
}

describe('platform event activation enqueue', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('queues a root activation for a subscribed platform event', async () => {
    const { organizationId } = await subscriber('Enqueue Org', [
      'connection.deleted',
    ]);

    recordLifecycleEvent({
      organizationId,
      entityType: 'connection',
      op: 'deleted',
      entityId: 42,
      summary: 'Connection deleted',
    });

    const queued = await waitForActivations(organizationId, 1);
    expect(queued).toHaveLength(1);
    const activation = queued[0]!;
    expect(activation.organizationId).toBe(organizationId);
    expect(activation.eventId).toBeGreaterThan(0);
    // A root: it is its own root, nothing ran before it, depth starts at 1.
    expect(activation.rootEventIds).toEqual([activation.eventId]);
    expect(activation.causalAutomationIds).toEqual([]);
    expect(activation.depth).toBe(1);
  });

  it('queues nothing when no Automation subscribes to the type', async () => {
    // Subscribes to a DIFFERENT platform type, so the org has a workspace
    // subscription but not one for the row being written.
    const { organizationId } = await subscriber('Unsubscribed Org', [
      'connection.deleted',
    ]);

    recordLifecycleEvent({
      organizationId,
      entityType: 'device',
      op: 'created',
      entityId: 7,
      summary: 'Device created',
    });

    // Give the fire-and-forget write time to settle before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await queuedActivations(organizationId)).toEqual([]);
  });

  it('names the producing Automation as its own causal path', async () => {
    const { organizationId, automationId } = await subscriber(
      'Self Trigger Org',
      ['connection.deleted']
    );

    // The same audit write, but driven by the subscribing Automation — the
    // shape that would otherwise loop forever, since every self-write mints a
    // fresh root at depth 1 and the depth cap never bites.
    await runWithActingAutomation({ automationId }, async () => {
      recordLifecycleEvent({
        organizationId,
        entityType: 'connection',
        op: 'deleted',
        entityId: 99,
        summary: 'Connection deleted by automation',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const queued = await waitForActivations(organizationId, 1);
    expect(queued).toHaveLength(1);
    // Ancestry names the producer, so the matcher skips it and the Automation
    // cannot be woken by the audit exhaust of its own write.
    expect(queued[0]!.causalAutomationIds).toEqual([automationId]);
  });

  it('stamps the producing Automation on the audit row itself', async () => {
    const { organizationId, automationId } = await subscriber('Stamp Org', [
      'connection.deleted',
    ]);

    await runWithActingAutomation({ automationId }, async () => {
      recordLifecycleEvent({
        organizationId,
        entityType: 'connection',
        op: 'deleted',
        entityId: 123,
        summary: 'Connection deleted by automation',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const sql = getTestDb();
    const rows = await sql<{ automation_id: number | null }>`
      SELECT automation_id
      FROM public.events
      WHERE organization_id = ${organizationId}
        AND metadata->>'_lobu_event_type' = 'connection.deleted'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.automation_id)).toBe(automationId);
  });

  it('leaves an unattributed write as a genuine root', async () => {
    const { organizationId } = await subscriber('Root Org', [
      'connection.deleted',
    ]);

    // No acting scope: a person in the UI, a cron tick, a connector sync.
    recordLifecycleEvent({
      organizationId,
      entityType: 'connection',
      op: 'deleted',
      entityId: 5,
      summary: 'Connection deleted by a person',
    });

    const queued = await waitForActivations(organizationId, 1);
    expect(queued[0]!.causalAutomationIds).toEqual([]);

    const sql = getTestDb();
    const rows = await sql<{ automation_id: number | null }>`
      SELECT automation_id
      FROM public.events
      WHERE organization_id = ${organizationId}
        AND metadata->>'_lobu_event_type' = 'connection.deleted'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows[0]!.automation_id).toBeNull();
  });
});

/**
 * Inheriting the producing run's chain.
 *
 * Naming only the immediate producer closes the SELF loop but leaves a mutual
 * one open: A writes (causal `[A]`) wakes B, B writes (causal `[B]`) wakes A,
 * forever, because every audit row starts a fresh root at depth 1 and the
 * depth cap therefore never accrues. These cover the inheritance that makes
 * each hop a real step in one chain.
 */
describe('audit rows inherit the producing run causal chain', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  /** A run for `automationId` that was itself woken by a workspace event. */
  async function runWokenByWorkspaceEvent(args: {
    organizationId: string;
    automationId: number;
    upstreamAutomationId: number;
    rootEventId: number;
    depth: number;
  }): Promise<{ runId: number }> {
    const sql = getTestDb();
    const rows = (await sql`
      INSERT INTO public.runs (
        organization_id, run_type, action_key, status, automation_id,
        approved_input
      ) VALUES (
        ${args.organizationId}, 'automation', 'run_automation', 'running',
        ${args.automationId},
        ${sql.json({
          trigger_signals: [
            {
              kind: 'event',
              source: 'workspace',
              event_id: args.rootEventId,
              event_type: 'connection.deleted',
              delivery_id: `workspace-event:${args.rootEventId}`,
              occurred_at: new Date().toISOString(),
              root_event_ids: [args.rootEventId],
              causal_automation_ids: [args.upstreamAutomationId],
              depth: args.depth,
            },
          ],
        })}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
    return { runId: Number(rows[0]!.id) };
  }

  it('accrues depth and ancestry instead of minting a fresh root', async () => {
    const { organizationId, automationId, api, agentId } = await subscriber(
      'Chain Org',
      ['connection.deleted']
    );
    const upstreamAutomationId = await secondAutomation(api, agentId, 'upstream');
    const rootEventId = 4242;
    const { runId } = await runWokenByWorkspaceEvent({
      organizationId,
      automationId,
      upstreamAutomationId,
      rootEventId,
      depth: 1,
    });

    await runWithActingAutomation({ automationId, runId }, async () => {
      recordLifecycleEvent({
        organizationId,
        entityType: 'connection',
        op: 'deleted',
        entityId: 77,
        summary: 'Connection deleted inside a woken run',
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const queued = await waitForActivations(organizationId, 1);
    expect(queued).toHaveLength(1);
    const activation = queued[0]!;
    // Depth ACCRUES — this is the property that makes MAX_WORKSPACE_EVENT_DEPTH
    // reachable across audit-mediated hops. A fresh root would report 1.
    expect(activation.depth).toBe(2);
    // The chain keeps its original root rather than restarting at this row.
    expect(activation.rootEventIds).toEqual([rootEventId]);
    // Both the upstream Automation and this producer are excluded downstream,
    // which is what stops the mutual A -> B -> A cascade.
    expect(activation.causalAutomationIds).toEqual([
      upstreamAutomationId,
      automationId,
    ]);
  });

  it('commits a transactional mutation while terminating an over-broad causal chain', async () => {
    const { organizationId, automationId, api, agentId } = await subscriber(
      'Causality Cap Org',
      ['connection.deleted']
    );
    const upstreamAutomationId = await secondAutomation(
      api,
      agentId,
      'cap-upstream'
    );
    const sql = getTestDb();
    const roots = Array.from(
      { length: MAX_COALESCED_AUTOMATION_EVENT_INPUTS * 2 },
      (_, index) => index + 1
    );
    const signals = [
      roots.slice(0, MAX_COALESCED_AUTOMATION_EVENT_INPUTS),
      roots.slice(MAX_COALESCED_AUTOMATION_EVENT_INPUTS),
    ].map((rootEventIds, index) => ({
      kind: 'event',
      source: 'workspace',
      event_id: rootEventIds[0],
      event_type: 'connection.deleted',
      delivery_id: `workspace-event:cap-${index}`,
      occurred_at: new Date().toISOString(),
      root_event_ids: rootEventIds,
      causal_automation_ids: [upstreamAutomationId],
      depth: 2,
    }));
    const [sourceRun] = await sql<{ id: number }>`
      INSERT INTO public.runs (
        organization_id, run_type, action_key, status, automation_id,
        approved_input
      ) VALUES (
        ${organizationId}, 'automation', 'run_automation', 'running',
        ${automationId}, ${sql.json({ trigger_signals: signals })}
      )
      RETURNING id
    `;
    const originId = `causality_cap_transaction_${Date.now()}`;

    await runWithActingAutomation(
      { automationId, runId: Number(sourceRun.id) },
      () =>
        sql.begin(async (tx) => {
          await tx`UPDATE organization SET name = 'Causality cap committed' WHERE id = ${organizationId}`;
          await insertConnectionlessAuditEvent(
            {
              entityIds: [],
              organizationId,
              originId,
              title: 'Connection deleted at causality cap',
              semanticType: 'change',
            },
            { subject: 'connection', op: 'deleted' },
            { sql: tx }
          );
        })
    );

    const [organization] = await sql<{ name: string }>`
      SELECT name FROM organization WHERE id = ${organizationId}
    `;
    expect(organization.name).toBe('Causality cap committed');
    expect(
      await sql`SELECT id FROM events
        WHERE organization_id = ${organizationId} AND origin_id = ${originId}`
    ).toHaveLength(1);
    expect(await queuedActivations(organizationId)).toEqual([]);
  });

  it('resolves the run through the declared window when the lane has no run id', async () => {
    const { organizationId, automationId, api, agentId } = await subscriber(
      'Window Org',
      ['connection.deleted']
    );
    const upstreamAutomationId = await secondAutomation(api, agentId, 'upstream');
    const rootEventId = 5353;
    const sql = getTestDb();
    const [sourceRun] = await sql<{ id: number }[]>`
      INSERT INTO public.runs (
        organization_id, run_type, action_key, status, automation_id,
        approved_input
      ) VALUES (
        ${organizationId}, 'automation', 'run_automation', 'running',
        ${automationId},
        ${sql.json({
          trigger_signals: [
            {
              kind: 'event',
              source: 'workspace',
              event_id: rootEventId,
              event_type: 'connection.deleted',
              delivery_id: `workspace-event:${rootEventId}`,
              occurred_at: new Date().toISOString(),
              root_event_ids: [rootEventId],
              causal_automation_ids: [upstreamAutomationId],
              depth: 3,
            },
          ],
        })}
      ) RETURNING id
    `;

    // The declared Automation source carries the producing run.
    await runWithActingAutomation(
      { automationId, runId: sourceRun.id },
      async () => {
        recordLifecycleEvent({
          organizationId,
          entityType: 'connection',
          op: 'deleted',
          entityId: 88,
          summary: 'Connection deleted by an agent-lane run',
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    );

    const queued = await waitForActivations(organizationId, 1);
    expect(queued[0]!.depth).toBe(4);
    expect(queued[0]!.rootEventIds).toEqual([rootEventId]);
  });

  it('does not inherit when an explicit producer disagrees with the ambient scope', async () => {
    const { organizationId, automationId, api, agentId } = await subscriber(
      'Mismatch Org',
      ['connection.deleted']
    );
    // A REAL second Automation: `events.automation_id` carries a foreign key,
    // so a fabricated id would fail the insert rather than test attribution.
    const otherAutomationId = await secondAutomation(api, agentId, 'other');
    const { runId } = await runWokenByWorkspaceEvent({
      organizationId,
      automationId,
      upstreamAutomationId: automationId,
      rootEventId: 6464,
      depth: 2,
    });

    // Inside the scope of `automationId`'s run, but the row is explicitly
    // attributed to a DIFFERENT Automation. Inheriting the surrounding run's
    // chain would put another Automation's ancestry on this row.
    await runWithActingAutomation({ automationId, runId }, async () => {
      await insertConnectionlessAuditEvent(
        {
          entityIds: [],
          organizationId,
          originId: `explicit_producer_${Date.now()}`,
          title: 'Connection deleted, explicitly attributed',
          semanticType: 'change',
          automationId: otherAutomationId,
          metadata: {
            category: 'lifecycle',
            entity_type: 'connection',
            op: 'deleted',
            entity_id: '55',
          },
        },
        { subject: 'connection', op: 'deleted' }
      );
    });

    const queued = await waitForActivations(organizationId, 1);
    expect(queued[0]!.causalAutomationIds).toEqual([otherAutomationId]);
    expect(queued[0]!.depth).toBe(1);
  });

  it('starts a fresh chain when the producing run had no workspace trigger', async () => {
    const { organizationId, automationId } = await subscriber('Fresh Org', [
      'connection.deleted',
    ]);
    const sql = getTestDb();
    // A schedule- or connector-triggered run: real producer, no upstream chain.
    const rows = (await sql`
      INSERT INTO public.runs (
        organization_id, run_type, action_key, status, automation_id
      ) VALUES (
        ${organizationId}, 'automation', 'run_automation', 'running',
        ${automationId}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    await runWithActingAutomation(
      { automationId, runId: Number(rows[0]!.id) },
      async () => {
        recordLifecycleEvent({
          organizationId,
          entityType: 'connection',
          op: 'deleted',
          entityId: 66,
          summary: 'Connection deleted by a scheduled run',
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    );

    const queued = await waitForActivations(organizationId, 1);
    expect(queued[0]!.depth).toBe(1);
    expect(queued[0]!.causalAutomationIds).toEqual([automationId]);
  });

  it('starts a fresh chain when the run was woken by a connector event', async () => {
    const { organizationId, automationId } = await subscriber('Connector Org', [
      'connection.deleted',
    ]);
    const sql = getTestDb();
    // A connector-triggered run: `approved_input` HAS trigger signals, but none
    // of them workspace ones. Deriving ancestry from these would produce an
    // EMPTY root set, which `activateWorkspaceEventTask` rejects — the row must
    // instead start its own chain.
    const rows = (await sql`
      INSERT INTO public.runs (
        organization_id, run_type, action_key, status, automation_id,
        approved_input
      ) VALUES (
        ${organizationId}, 'automation', 'run_automation', 'running',
        ${automationId},
        ${sql.json({
          trigger_signals: [
            {
              connector_key: 'gmail',
              event_type: 'message.received',
              delivery_id: 'gmail:msg-1',
              label: 'New message',
              input_text: 'New message received',
            },
          ],
        })}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    await runWithActingAutomation(
      { automationId, runId: Number(rows[0]!.id) },
      async () => {
        recordLifecycleEvent({
          organizationId,
          entityType: 'connection',
          op: 'deleted',
          entityId: 99,
          summary: 'Connection deleted by a connector-triggered run',
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    );

    const queued = await waitForActivations(organizationId, 1);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.rootEventIds).toHaveLength(1);
    expect(queued[0]!.depth).toBe(1);
    expect(queued[0]!.causalAutomationIds).toEqual([automationId]);
  });

  it('does not inherit through a window belonging to another Automation', async () => {
    const { organizationId, automationId, api, agentId } = await subscriber(
      'Foreign Window Org',
      ['connection.deleted']
    );
    const upstreamAutomationId = await secondAutomation(api, agentId, 'upstream');
    const sql = getTestDb();
    // The declared run belongs to the other Automation. Caller input must not
    // be allowed to plant that Automation into this row's causal path.
    const [sourceRun] = await sql<{ id: number }[]>`
      INSERT INTO public.runs (
        organization_id, run_type, action_key, status, automation_id,
        approved_input
      ) VALUES (
        ${organizationId}, 'automation', 'run_automation', 'running',
        ${upstreamAutomationId},
        ${sql.json({
          trigger_signals: [
            {
              kind: 'event',
              source: 'workspace',
              event_id: 7575,
              event_type: 'connection.deleted',
              delivery_id: 'workspace-event:7575',
              occurred_at: new Date().toISOString(),
              root_event_ids: [7575],
              causal_automation_ids: [upstreamAutomationId],
              depth: 5,
            },
          ],
        })}
      ) RETURNING id
    `;

    await runWithActingAutomation(
      { automationId, runId: sourceRun.id },
      async () => {
        recordLifecycleEvent({
          organizationId,
          entityType: 'connection',
          op: 'deleted',
          entityId: 111,
          summary: 'Connection deleted with a foreign declared window',
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    );

    const queued = await waitForActivations(organizationId, 1);
    expect(queued[0]!.depth).toBe(1);
    expect(queued[0]!.rootEventIds).toHaveLength(1);
    expect(queued[0]!.causalAutomationIds).toEqual([automationId]);
  });
});
