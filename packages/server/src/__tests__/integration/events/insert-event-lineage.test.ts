/**
 * A supersede is the next version of the same thing. Lineage is copied from
 * the predecessor inside insertEvent — omit or null cannot drop it. A later
 * number restamps this version's producer/run.
 *
 * Human canvas corrections keep the producer stamp and stay visible because
 * self-exclusion excepts canvas_state + metadata.correction. Tombstones keep
 * the stamp and stay hidden.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { supersedeActionEvent } from '../../../tools/admin/approval-events';
import { TOMBSTONE_SEMANTIC_TYPE } from '../../../tools/constants';
import { executeDataSources } from '../../../utils/execute-data-sources';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

async function insertAutomation(
  organizationId: string,
  userId: string,
  slug: string
): Promise<{ id: number; versionId: number }> {
  const sql = getDb();
  const [automation] = await sql`
    INSERT INTO automations (
      organization_id, created_by, automation_group_id, name, slug, agent_id
    ) VALUES (
      ${organizationId}, ${userId}, 0, ${slug}, ${slug}, 'lineage-agent'
    )
    RETURNING id
  `;
  const id = Number(automation.id);
  await sql`UPDATE automations SET automation_group_id = ${id} WHERE id = ${id}`;
  const [version] = await sql`
    INSERT INTO automation_versions (
      automation_id, version, name, created_by, prompt
    ) VALUES (
      ${id}, 1, ${slug}, ${userId}, 'prompt'
    )
    RETURNING id
  `;
  return { id, versionId: Number(version.id) };
}

async function insertRun(organizationId: string): Promise<number> {
  const [row] = await getDb()`
    INSERT INTO runs
      (organization_id, run_type, status, approval_status, action_key, created_at)
    VALUES
      (${organizationId}, 'action', 'pending', 'pending', 'screenshot', NOW())
    RETURNING id
  `;
  return Number((row as { id: number }).id);
}

async function insertFeed(
  organizationId: string,
  connectionId: number,
  feedKey: string
): Promise<number> {
  const [row] = await getDb()`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status, created_at, updated_at
    ) VALUES (
      ${organizationId}, ${connectionId}, ${feedKey}, 'active', NOW(), NOW()
    )
    RETURNING id
  `;
  return Number((row as { id: number }).id);
}

async function lineageOf(eventId: number): Promise<{
  automation_id: number | null;
  automation_version_id: number | null;
  run_id: number | null;
  connection_id: number | null;
  connector_key: string | null;
  feed_id: number | null;
  feed_key: string | null;
  identity_ns: string | null;
  identity_key: string | null;
  origin_parent_id: string | null;
}> {
  const [row] = await getDb()`
    SELECT automation_id, automation_version_id, run_id, connection_id, connector_key,
           feed_id, feed_key, identity_ns, identity_key, origin_parent_id
    FROM events WHERE id = ${eventId}
  `;
  const r = row as Record<string, unknown>;
  return {
    automation_id: r.automation_id == null ? null : Number(r.automation_id),
    automation_version_id:
      r.automation_version_id == null ? null : Number(r.automation_version_id),
    run_id: r.run_id == null ? null : Number(r.run_id),
    connection_id: r.connection_id == null ? null : Number(r.connection_id),
    connector_key: (r.connector_key as string | null) ?? null,
    feed_id: r.feed_id == null ? null : Number(r.feed_id),
    feed_key: (r.feed_key as string | null) ?? null,
    identity_ns: (r.identity_ns as string | null) ?? null,
    identity_key: (r.identity_key as string | null) ?? null,
    origin_parent_id: (r.origin_parent_id as string | null) ?? null,
  };
}

describe('insertEvent lineage on supersede', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('copies producer and source lineage even when the successor omits them', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const automation = await insertAutomation(org.id, user.id, 'lineage-copy');
    const runId = await insertRun(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });
    const feedId = await insertFeed(org.id, Number(connection.id), 'front');

    const prior = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-root',
      title: 'root',
      content: 'root',
      semanticType: 'observation',
      connectorKey: 'reddit',
      connectionId: Number(connection.id),
      feedKey: 'front',
      feedId,
      runId,
      automationId: automation.id,
      automationVersionId: automation.versionId,
      parentOriginId: 'parent-origin',
      identity: { ns: 'test.lineage', key: 'thing-1' },
    });

    const next = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-next',
      title: 'next',
      content: 'next',
      semanticType: 'observation',
      supersedesEventId: Number(prior.id),
    });

    expect(await lineageOf(Number(next.id))).toEqual({
      automation_id: automation.id,
      automation_version_id: automation.versionId,
      run_id: runId,
      connection_id: Number(connection.id),
      connector_key: 'reddit',
      feed_id: feedId,
      feed_key: 'front',
      identity_ns: 'test.lineage',
      identity_key: 'thing-1',
      origin_parent_id: 'parent-origin',
    });
  });

  it('keeps lineage when the successor explicitly passes nulls', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const automation = await insertAutomation(org.id, user.id, 'lineage-nulls');
    const runId = await insertRun(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });
    const feedId = await insertFeed(org.id, Number(connection.id), 'front');

    const prior = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-nulls-root',
      title: 'root',
      content: 'root',
      semanticType: 'observation',
      connectorKey: 'reddit',
      connectionId: Number(connection.id),
      feedKey: 'front',
      feedId,
      runId,
      automationId: automation.id,
      automationVersionId: automation.versionId,
      parentOriginId: 'parent-origin',
      identity: { ns: 'test.lineage', key: 'thing-nulls' },
    });

    const next = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-nulls-next',
      title: 'next',
      content: 'next',
      semanticType: 'observation',
      automationId: null,
      automationVersionId: null,
      runId: null,
      connectionId: null,
      connectorKey: null,
      feedId: null,
      feedKey: null,
      parentOriginId: null,
      identity: null,
      supersedesEventId: Number(prior.id),
    });

    expect(await lineageOf(Number(next.id))).toEqual({
      automation_id: automation.id,
      automation_version_id: automation.versionId,
      run_id: runId,
      connection_id: Number(connection.id),
      connector_key: 'reddit',
      feed_id: feedId,
      feed_key: 'front',
      identity_ns: 'test.lineage',
      identity_key: 'thing-nulls',
      origin_parent_id: 'parent-origin',
    });
  });

  it('uses explicitly supplied attribution for the new stored version', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const firstAutomation = await insertAutomation(
      org.id,
      user.id,
      'lineage-first-producer'
    );
    const nextAutomation = await insertAutomation(
      org.id,
      user.id,
      'lineage-next-producer'
    );
    const firstRunId = await insertRun(org.id);
    const nextRunId = await insertRun(org.id);

    const prior = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-attribution-root',
      title: 'root',
      content: 'root',
      semanticType: 'observation',
      runId: firstRunId,
      automationId: firstAutomation.id,
      automationVersionId: firstAutomation.versionId,
      parentOriginId: 'first-parent',
    });

    const next = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-attribution-next',
      title: 'next',
      content: 'next',
      semanticType: 'observation',
      runId: nextRunId,
      automationId: nextAutomation.id,
      automationVersionId: nextAutomation.versionId,
      parentOriginId: 'next-parent',
      supersedesEventId: Number(prior.id),
    });

    expect(await lineageOf(Number(next.id))).toMatchObject({
      run_id: nextRunId,
      automation_id: nextAutomation.id,
      automation_version_id: nextAutomation.versionId,
      origin_parent_id: 'next-parent',
    });
  });

  it('does not re-supersede a copied-parent head on a parentless re-sync', async () => {
    const org = await createTestOrganization();
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });

    const root = await insertEvent(
      {
        entityIds: [],
        organizationId: org.id,
        originId: 'lineage-resync',
        title: 'item',
        content: 'v1',
        semanticType: 'observation',
        connectorKey: 'reddit',
        connectionId: Number(connection.id),
        parentOriginId: 'resync-parent',
      },
      { onConflictUpdate: true }
    );
    expect(root.change).toBe('inserted');

    // Content changed, parent omitted: supersedes and copies the parent.
    const resyncParams = {
      entityIds: [],
      organizationId: org.id,
      originId: 'lineage-resync',
      title: 'item',
      content: 'v2',
      semanticType: 'observation',
      connectorKey: 'reddit',
      connectionId: Number(connection.id),
    };
    const superseded = await insertEvent(resyncParams, { onConflictUpdate: true });
    expect(superseded.change).toBe('superseded');
    expect(await lineageOf(Number(superseded.id))).toMatchObject({
      origin_parent_id: 'resync-parent',
    });

    // Identical parentless re-sync: the copied parent must not read as a
    // difference, or every sync would mint a new stored version forever.
    const resync = await insertEvent(resyncParams, { onConflictUpdate: true });
    expect(resync.change).toBe('unchanged');
    expect(Number(resync.id)).toBe(Number(superseded.id));
  });

  it('fails closed when the predecessor is missing', async () => {
    const org = await createTestOrganization();
    await expect(
      insertEvent({
        entityIds: [],
        organizationId: org.id,
        originId: 'lineage-missing-prior',
        title: 'next',
        content: 'next',
        semanticType: 'observation',
        supersedesEventId: 9_000_000_001,
      })
    ).rejects.toThrow(/cannot supersede event 9000000001/i);
  });

  it('preserves Automation attribution through an approval successor that does not pass it', async () => {
    const org = await createTestOrganization();
    const reviewer = await createTestUser({ name: 'Ada Approver' });
    const automation = await insertAutomation(org.id, reviewer.id, 'lineage-approval');
    const runId = await insertRun(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'apple.computer_use',
    });

    await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `run_${runId}_pending`,
      title: 'screenshot — pending approval',
      content: 'Agent requested a screenshot.',
      semanticType: 'operation',
      connectorKey: 'apple.computer_use',
      connectionId: Number(connection.id),
      runId,
      automationId: automation.id,
      automationVersionId: automation.versionId,
      interactionType: 'approval',
      interactionStatus: 'pending',
      metadata: { status: 'pending_approval' },
    });

    const approvedId = await supersedeActionEvent(
      runId,
      org.id,
      'confirmed',
      'screenshot — executing',
      'Operation confirmed',
      {},
      { userId: reviewer.id, name: reviewer.name }
    );

    expect(await lineageOf(approvedId!)).toMatchObject({
      automation_id: automation.id,
      automation_version_id: automation.versionId,
      run_id: runId,
      connector_key: 'apple.computer_use',
      connection_id: Number(connection.id),
    });
  });

  it('shows a human canvas correction, but not other self-produced rows or its tombstone', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    const automation = await insertAutomation(org.id, user.id, 'lineage-visibility');

    const output = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'produced-output',
      title: 'produced',
      content: 'produced',
      semanticType: 'observation',
      automationId: automation.id,
      occurredAt: new Date('2026-08-01T12:00:00Z'),
    });

    const spoofedCorrection = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'produced-correction-flag',
      title: 'still produced',
      content: 'still produced',
      semanticType: 'observation',
      automationId: automation.id,
      metadata: { correction: true },
      occurredAt: new Date('2026-08-01T12:30:00Z'),
    });

    const correction = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'produced-correction',
      title: 'corrected',
      content: 'corrected',
      semanticType: 'canvas_state',
      metadata: { correction: true },
      occurredAt: new Date('2026-08-01T13:00:00Z'),
      supersedesEventId: Number(output.id),
    });

    const sql = getTestDb();
    const afterCorrection = await executeDataSources(
      { stories: { query: 'SELECT id, semantic_type FROM events ORDER BY id' } },
      { organizationId: org.id, excludeProducedByAutomationId: automation.id },
      sql
    );
    const correctionIds = (afterCorrection.stories ?? []).map((row) =>
      Number((row as { id: number }).id)
    );
    expect(correctionIds).toContain(Number(correction.id));
    expect(correctionIds).not.toContain(Number(output.id));
    expect(correctionIds).not.toContain(Number(spoofedCorrection.id));

    const tombstone = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `tomb_${Number(correction.id)}`,
      semanticType: TOMBSTONE_SEMANTIC_TYPE,
      payloadType: 'empty',
      content: null,
      metadata: { tombstone: true, deleted_event_id: Number(correction.id) },
      supersedesEventId: Number(correction.id),
    });

    const afterTombstone = await executeDataSources(
      { stories: { query: 'SELECT id, semantic_type FROM events ORDER BY id' } },
      { organizationId: org.id, excludeProducedByAutomationId: automation.id },
      sql
    );
    const tombstoneIds = (afterTombstone.stories ?? []).map((row) =>
      Number((row as { id: number }).id)
    );
    expect(tombstoneIds).not.toContain(Number(tombstone.id));
    expect(await lineageOf(Number(tombstone.id))).toMatchObject({
      automation_id: automation.id,
    });
  });
});
