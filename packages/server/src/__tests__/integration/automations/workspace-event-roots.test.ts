/**
 * Root workspace events: rows the platform wrote itself, with no Automation
 * upstream of them.
 *
 * Before this, `loadWorkspaceEvent` threw on any event whose `automation_id`
 * was null, so only Automation outputs could ever reach a subscriber — a
 * device coming online or a connection being deleted was unsubscribable by
 * construction. These tests drive the real writer (`insertConnectionlessAuditEvent`)
 * rather than hand-building rows, so a regression in how the type is stamped
 * fails here too.
 *
 * Nothing enqueues roots yet; `activateWorkspaceEventTask` is called directly.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { activateWorkspaceEventTask } from '../../../automations/workspace-event';
import type { WorkspaceEventActivationTaskPayload } from '../../../automations/workspace-event-contract';
import {
  insertConnectionlessAuditEvent,
  insertEvent,
} from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { isPlatformEventType } from '../../../automations/platform-event-catalog';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { createTestAgent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

async function subscriberOrg(eventTypes: string[][]) {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: 'Workspace Event Root Org' });
  const ownerUserId = workspace.users.owner.id;
  // A workspace trigger may only name an event type some catalog declares
  // (`assertAutomationTriggerConnections`). Platform `<subject>.<op>` types come
  // from the computed platform catalog and need no declaration — that is the
  // point, and the tests below rely on it. Only non-platform types are declared
  // here, on `$member`, whose `event_kinds` is the org-wide content registry.
  const declared = eventTypes.flat().filter((type) => !isPlatformEventType(type));
  await ensureMemberEntityType(workspace.org.id);
  if (declared.length > 0) {
    await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json(
        Object.fromEntries(declared.map((type) => [type, { description: type }]))
      )}
      WHERE organization_id = ${workspace.org.id} AND slug = '$member'
    `;
  }
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'workspace-event-root-agent',
  });
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });
  const automationIds: number[] = [];
  for (const [index, types] of eventTypes.entries()) {
    const created = (await api.automations.create({
      slug: `root-consumer-${index}`,
      prompt: 'Handle the platform event.',
      triggers: [
        {
          kind: 'event',
          source: 'workspace',
          event_types: types,
          execution: 'window',
          active_run: 'queue',
        },
      ],
      managed_agent_id: agent.agentId,
    })) as { automation_id: string };
    automationIds.push(Number(created.automation_id));
  }
  return { workspace, automationIds };
}

/** The payload the platform will hand a root: itself as the only ancestor-free root. */
function rootPayload(
  organizationId: string,
  eventId: number
): WorkspaceEventActivationTaskPayload {
  return {
    organizationId,
    eventId,
    rootEventIds: [eventId],
    causalAutomationIds: [],
    depth: 1,
  };
}

describe('workspace events with no producing Automation', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('activates a subscriber named by the stamped <subject>.<op> type', async () => {
    const sql = getTestDb();
    // The second Automation subscribes to a sibling op. It exists to prove the
    // GIN needle narrows rather than matching every dotted subscriber.
    const { workspace, automationIds } = await subscriberOrg([
      ['device.deleted'],
      ['connection.deleted'],
    ]);
    const [deviceConsumer] = automationIds;

    const event = await insertConnectionlessAuditEvent(
      {
        organizationId: workspace.org.id,
        entityIds: [],
        originId: 'device:root-worker:deleted',
        semanticType: 'change',
        title: 'Device came online',
        content: 'A device worker started reporting.',
        metadata: { category: 'device', worker_id: 'root-worker' },
      },
      { subject: 'device', op: 'deleted' }
    );

    // The writer stamped it and left `automation_id` null: this row is a root.
    const stored = await sql<{
      automation_id: number | null;
      event_type: string | null;
    }>`
      SELECT automation_id, metadata->>'_lobu_event_type' AS event_type
      FROM events WHERE id = ${event.id}
    `;
    expect(stored[0]).toEqual({
      automation_id: null,
      event_type: 'device.deleted',
    });

    await expect(
      activateWorkspaceEventTask(rootPayload(workspace.org.id, event.id), sql)
    ).resolves.toMatchObject({
      matched: 1,
      queued: 1,
      invalidCausalPath: false,
    });

    const runs = await sql<{
      automation_id: number;
      approved_input: Record<string, unknown>;
    }>`
      SELECT automation_id, approved_input
      FROM runs
      WHERE run_type = 'automation'
        AND organization_id = ${workspace.org.id}
    `;
    expect(runs.map((row) => Number(row.automation_id))).toEqual([
      deviceConsumer,
    ]);
    expect(runs[0]?.approved_input).toMatchObject({
      delivery_ids: [`workspace-event:${event.id}`],
      trigger_signal: {
        kind: 'event',
        source: 'workspace',
        event_id: event.id,
        // The specific name, not the `change` semantic type every audit row
        // shares — otherwise the consumer cannot tell what happened.
        event_type: 'device.deleted',
        causal_automation_ids: [],
        depth: 1,
      },
    });
  });

  it('does not let a `change` subscription become an audit firehose', async () => {
    const sql = getTestDb();
    const { workspace } = await subscriberOrg([['change']]);

    const event = await insertConnectionlessAuditEvent(
      {
        organizationId: workspace.org.id,
        entityIds: [],
        originId: 'connection:root-conn:deleted',
        semanticType: 'change',
        title: 'Connection deleted',
        content: 'A connection was removed.',
        metadata: { category: 'connection' },
      },
      { subject: 'connection', op: 'deleted' }
    );

    // Every audit row carries `change`, so matching it would wake this
    // Automation on essentially every write in the organization. An audit row
    // is named by its stamped type and nothing else.
    await expect(
      activateWorkspaceEventTask(rootPayload(workspace.org.id, event.id), sql)
    ).resolves.toMatchObject({ matched: 0, queued: 0 });
    expect(
      await sql`
        SELECT id FROM runs
        WHERE run_type = 'automation' AND organization_id = ${workspace.org.id}
      `
    ).toHaveLength(0);
  });

  it('terminates a root that arrives claiming ancestry', async () => {
    const sql = getTestDb();
    const { workspace, automationIds } = await subscriberOrg([['device.deleted']]);

    const event = await insertConnectionlessAuditEvent(
      {
        organizationId: workspace.org.id,
        entityIds: [],
        originId: 'device:forged-worker:deleted',
        semanticType: 'change',
        title: 'Device came online',
        content: 'A device worker started reporting.',
        metadata: {},
      },
      { subject: 'device', op: 'deleted' }
    );

    // Nothing ran before a root, so a non-empty causal path is incoherent.
    // Honoring it would let the payload name the subscriber as its own
    // ancestor, which the matcher reads as "already ran" and skips.
    await expect(
      activateWorkspaceEventTask(
        {
          ...rootPayload(workspace.org.id, event.id),
          causalAutomationIds: automationIds,
        },
        sql
      )
    ).resolves.toMatchObject({
      matched: 0,
      queued: 0,
      invalidCausalPath: true,
    });
    expect(
      await sql`
        SELECT id FROM runs
        WHERE run_type = 'automation' AND organization_id = ${workspace.org.id}
      `
    ).toHaveLength(0);
  });

  it('loads a producerless event that carries no stamp', async () => {
    const sql = getTestDb();
    const { workspace } = await subscriberOrg([['observation']]);

    // Not every producerless row is an audit row. This one predates the stamp
    // in shape, and must still load and match on its semantic type rather than
    // throwing the way `loadWorkspaceEvent` used to.
    const event = await insertEvent({
      organizationId: workspace.org.id,
      entityIds: [],
      originId: 'unstamped-producerless-observation',
      semanticType: 'observation',
      content: 'An observation with no producing Automation.',
    });

    await expect(
      activateWorkspaceEventTask(rootPayload(workspace.org.id, event.id), sql)
    ).resolves.toMatchObject({ matched: 1, queued: 1 });
  });

  it('still requires a produced event to name its producer', async () => {
    const sql = getTestDb();
    const { workspace, automationIds } = await subscriberOrg([['observation']]);
    const [consumerId] = automationIds;

    const event = await insertEvent({
      organizationId: workspace.org.id,
      entityIds: [],
      originId: 'produced-observation',
      semanticType: 'observation',
      content: 'An observation a different Automation produced.',
      automationId: consumerId,
    });

    // Relaxing the root gate must not relax this one: an event that DOES have
    // a producer still has to carry that producer in its causal path, or the
    // loop bound is unenforceable.
    await expect(
      activateWorkspaceEventTask(rootPayload(workspace.org.id, event.id), sql)
    ).resolves.toMatchObject({
      matched: 0,
      queued: 0,
      invalidCausalPath: true,
    });
  });
});
