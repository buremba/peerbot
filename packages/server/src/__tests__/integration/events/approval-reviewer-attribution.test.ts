/**
 * Approval reviewer attribution.
 *
 * When a human approves or rejects a queued action, the superseding event must
 * record *who* decided it — both the durable FK (`created_by`) and a
 * display-ready name in metadata (`reviewed_by_name` / `reviewed_by_id`). And
 * because a run's later system transitions (the worker reporting 'completed')
 * re-supersede without an acting user, the reviewer must be *inherited* down the
 * chain so the completed state still shows who authorized it.
 *
 * Contract under test: `supersedeActionEvent(runId, org, status, …, reviewer)`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { supersedeActionEvent } from '../../../tools/admin/manage_operations';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

async function insertActionRun(organizationId: string): Promise<number> {
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, status, approval_status, action_key, created_at)
    VALUES
      (${organizationId}, 'action', 'pending', 'pending', 'screenshot', NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertPendingApprovalEvent(
  organizationId: string,
  runId: number,
  extraMetadata: Record<string, unknown> = {}
): Promise<number> {
  const inserted = await insertEvent({
    entityIds: [],
    organizationId,
    originId: `run_${runId}_pending`,
    title: 'screenshot — pending approval',
    content: 'Agent requested a screenshot.',
    semanticType: 'operation',
    connectorKey: 'apple.computer_use',
    runId,
    interactionType: 'approval',
    interactionStatus: 'pending',
    metadata: { status: 'pending_approval', ...extraMetadata },
  });
  return Number(inserted.id);
}

async function metadataFor(eventId: number): Promise<{
  created_by: string | null;
  metadata: Record<string, unknown>;
  interaction_status: string | null;
}> {
  const rows = (await getDb()`
    SELECT created_by, metadata, interaction_status FROM events WHERE id = ${eventId}
  `) as Array<{
    created_by: string | null;
    metadata: Record<string, unknown>;
    interaction_status: string | null;
  }>;
  return rows[0];
}

describe('approval reviewer attribution', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('stamps the reviewer on an approve transition', async () => {
    const org = await createTestOrganization();
    const reviewer = await createTestUser({ name: 'Ada Approver' });
    const runId = await insertActionRun(org.id);
    await insertPendingApprovalEvent(org.id, runId);

    const approvedId = await supersedeActionEvent(
      runId,
      org.id,
      'confirmed',
      'screenshot — executing',
      'Operation confirmed',
      {},
      { userId: reviewer.id, name: reviewer.name }
    );
    expect(approvedId).toBeDefined();

    const approved = await metadataFor(approvedId!);
    expect(approved.interaction_status).toBe('approved');
    expect(approved.created_by).toBe(reviewer.id);
    expect(approved.metadata.reviewed_by_id).toBe(reviewer.id);
    expect(approved.metadata.reviewed_by_name).toBe('Ada Approver');
  });

  // Superseding spreads the prior row's metadata forward. A durable approval
  // written before the Behaviors rename (#2034) therefore keeps minting NEW
  // rows tagged `resourceKind: "watcher"` every time it is resolved — so the
  // legacy set is open, not closed, and no one-shot backfill can drain it.
  // The SPA matches `resourceKind === "behavior"` with no fallback, so such a
  // row renders no approval card. Canonicalizing on write closes the source.
  it('canonicalizes a legacy watcher resourceKind when superseding', async () => {
    const org = await createTestOrganization();
    const reviewer = await createTestUser({ name: 'Ada Approver' });
    const runId = await insertActionRun(org.id);
    await insertPendingApprovalEvent(org.id, runId, {
      resourceKind: 'watcher',
    });

    const approvedId = await supersedeActionEvent(
      runId,
      org.id,
      'confirmed',
      'behavior — executing',
      'Operation confirmed',
      {},
      { userId: reviewer.id, name: reviewer.name }
    );

    const approved = await metadataFor(approvedId!);
    expect(approved.metadata.resourceKind).toBe('behavior');
  });

  it('leaves a non-legacy resourceKind untouched when superseding', async () => {
    const org = await createTestOrganization();
    const runId = await insertActionRun(org.id);
    await insertPendingApprovalEvent(org.id, runId, {
      resourceKind: 'entity',
    });

    const approvedId = await supersedeActionEvent(
      runId,
      org.id,
      'confirmed',
      'entity — executing',
      'Operation confirmed'
    );

    const approved = await metadataFor(approvedId!);
    expect(approved.metadata.resourceKind).toBe('entity');
  });

  it('records the reviewer + reason on a reject transition', async () => {
    const org = await createTestOrganization();
    const reviewer = await createTestUser({ name: 'Rex Rejector' });
    const runId = await insertActionRun(org.id);
    await insertPendingApprovalEvent(org.id, runId);

    const rejectedId = await supersedeActionEvent(
      runId,
      org.id,
      'rejected',
      'screenshot — rejected',
      'Operation rejected',
      { reason: 'not needed' },
      { userId: reviewer.id, name: reviewer.name }
    );

    const rejected = await metadataFor(rejectedId!);
    expect(rejected.interaction_status).toBe('rejected');
    expect(rejected.created_by).toBe(reviewer.id);
    expect(rejected.metadata.reviewed_by_name).toBe('Rex Rejector');
    expect(rejected.metadata.reason).toBe('not needed');
  });

  it('inherits the reviewer onto a later system transition (completed)', async () => {
    const org = await createTestOrganization();
    const reviewer = await createTestUser({ name: 'Ada Approver' });
    const runId = await insertActionRun(org.id);
    await insertPendingApprovalEvent(org.id, runId);

    // Human approves…
    await supersedeActionEvent(
      runId,
      org.id,
      'confirmed',
      'screenshot — executing',
      'Operation confirmed',
      {},
      { userId: reviewer.id, name: reviewer.name }
    );

    // …then the worker reports completion with NO acting user (reviewer=null).
    const completedId = await supersedeActionEvent(
      runId,
      org.id,
      'completed',
      'screenshot — completed',
      'Operation completed',
      { output: { bytes: 1 } }
      // no reviewer arg — the worker isn't a user
    );

    const completed = await metadataFor(completedId!);
    expect(completed.interaction_status).toBe('completed');
    // The person who approved still owns the completed state.
    expect(completed.created_by).toBe(reviewer.id);
    expect(completed.metadata.reviewed_by_id).toBe(reviewer.id);
    expect(completed.metadata.reviewed_by_name).toBe('Ada Approver');
  });

  it('leaves no reviewer when none was ever supplied', async () => {
    const org = await createTestOrganization();
    const runId = await insertActionRun(org.id);
    await insertPendingApprovalEvent(org.id, runId);

    const completedId = await supersedeActionEvent(
      runId,
      org.id,
      'completed',
      'screenshot — completed',
      'Operation completed',
      { output: { bytes: 1 } }
    );

    const completed = await metadataFor(completedId!);
    expect(completed.created_by).toBeNull();
    expect(completed.metadata.reviewed_by_id).toBeUndefined();
    expect(completed.metadata.reviewed_by_name).toBeUndefined();
  });
});
