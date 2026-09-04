import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestEvent, seedOwnerContext } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

type ClaimResult = {
  run_id: number;
  context: { window_start: string; window_end: string; window_token: string };
};

/**
 * An Automation with NO managed agent and NO device worker is the shape an
 * external MCP client drives: `claim_next_window` opens the run, the same
 * client completes it. Every other suite seeds `managed_agent_id`, which makes
 * the run non-manual-open and skips the external claim-ownership fence
 * entirely — so this shape is the only one that exercises it.
 */
describe('external MCP claim then completion', () => {
  let sql: DbClient;
  let orgId: string;
  let userId: string;
  let entityId: number;
  let automationId: number;
  let api: TestApiClient;

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const seeded = await seedOwnerContext();
    sql = getTestDb() as unknown as DbClient;
    orgId = seeded.org.id;
    userId = seeded.user.id;
    const entity = await createTestEntity({
      name: 'External claim subject',
      organization_id: orgId,
      created_by: userId,
    });
    entityId = entity.id;
    api = await TestApiClient.for({ organizationId: orgId, userId, memberRole: 'owner' });
    const created = (await api.automations.create({
      entity_id: entityId,
      slug: 'external-claim',
      name: 'External claim',
      prompt: 'Extract durable signals from each arrival window.',
      sources: [
        {
          name: 'content',
          query:
            "SELECT id, occurred_at, payload_text FROM events WHERE semantic_type = 'content' ORDER BY occurred_at DESC, id DESC",
        },
      ],
      outputs: { signals: { event: 'observation' } },
      // Manual-only (no triggers), so no executor is required and both
      // `managed_agent_id` and `device_worker_id` stay null — the shape an
      // external MCP client claims and completes itself.
    })) as { automation_id: string };
    automationId = Number(created.automation_id);
  });

  it('completes a window the same caller claimed', async () => {
    await createTestEvent({
      entity_id: entityId,
      organization_id: orgId,
      content: 'Arrival inside the claimed window',
    });

    const claimed = (await api.automations.claimNextWindow({
      automation_id: String(automationId),
    })) as ClaimResult;

    const [run] = await sql<{ claimed_by: string | null }>`
      SELECT claimed_by FROM runs WHERE id = ${claimed.run_id}
    `;
    // claim_next_window records the caller as `external:{...}`.
    expect(String(run.claimed_by)).toMatch(/^external:/);

    const completed = (await api.automations.completeWindow({
      automation_id: String(automationId),
      run_id: claimed.run_id,
      window_token: claimed.context.window_token,
      extracted_data: { signals: [] },
    })) as { run_id: number; completed_now: boolean };

    expect(completed).toMatchObject({ run_id: claimed.run_id, completed_now: true });

    const [after] = await sql<{
      next_window_start: string | Date;
      last_completed_window_start: string | Date | null;
    }>`
      SELECT next_window_start, last_completed_window_start
      FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(after.next_window_start).toISOString()).toBe(claimed.context.window_end);
    expect(new Date(after.last_completed_window_start as string).toISOString()).toBe(
      claimed.context.window_start
    );
  });

  it('completes an empty window so the arrival mark still advances', async () => {
    const claimed = (await api.automations.claimNextWindow({
      automation_id: String(automationId),
    })) as ClaimResult;

    const completed = (await api.automations.completeWindow({
      automation_id: String(automationId),
      run_id: claimed.run_id,
      window_token: claimed.context.window_token,
      extracted_data: { signals: [] },
    })) as { completed_now: boolean };

    expect(completed.completed_now).toBe(true);

    const [after] = await sql<{ next_window_start: string | Date }>`
      SELECT next_window_start FROM automations WHERE id = ${automationId}
    `;
    expect(new Date(after.next_window_start).toISOString()).toBe(claimed.context.window_end);
  });
});
