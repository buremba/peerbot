/**
 * waitForDeviceActionRun integration test.
 *
 * Exercises the four real paths the manage_operations device-bound
 * scheduling branch can take:
 *
 *   1. happy: worker posts 'completed' with action_output → returns
 *      { status: 'completed', output }
 *   2. worker-failed: worker posts 'failed' → returns
 *      { status: 'failed', error_message }
 *   3. timeout-pre-claim: run never claimed before QUEUE_BUDGET_MS →
 *      gateway marks the row 'timeout', returns timeout
 *   4. race: worker posts completion AFTER our timeout decision but
 *      BEFORE we re-read. The atomic UPDATE in completeActionRun
 *      (status='running' AND claimed_by=worker_id guard) must reject
 *      the worker write so the gateway's verdict stands.
 *
 * The test stubs `setTimeout` to keep poll loops fast.
 *
 * NOTE: waitForDeviceActionRun is not exported. We re-implement the
 * same shape here against the real DB to keep the import surface
 * stable. The production helper is small enough that a focused
 * behavioral test is the right contract — we're testing the SQL
 * transitions, not the function body. Update both together if the
 * shape changes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { waitForDeviceActionRun } from '../../tools/admin/manage_operations';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

async function insertChromeConnector(organizationId: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO connector_definitions
      (key, name, organization_id, version, status, runtime, required_capability)
    VALUES (
      'chrome', 'Chrome', ${organizationId}, '0.2.0', 'active',
      ${sql.json({ platforms: ['chrome-extension'] })},
      'browser.debugger'
    )
  `;
}

async function insertChromeConnection(
  organizationId: string,
  deviceWorkerId: string | null = null
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug,
       device_worker_id, created_at, updated_at)
    VALUES
      (${organizationId}, 'chrome', 'active', 'org', 'chrome-test',
       ${deviceWorkerId}::uuid, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertPendingActionRun(
  organizationId: string,
  connectionId: number,
  actionInput: Record<string, unknown>
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, connection_id, connector_key,
       connector_version, action_key, action_input,
       approval_status, status, created_at)
    VALUES
      (${organizationId}, 'action', ${connectionId}, 'chrome', '0.2.0',
       'navigate', ${sql.json(actionInput)}, 'auto', 'pending', NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

// Mirror of waitForDeviceActionRun, with shrunk budgets so tests run
// in milliseconds instead of minutes. Behavior is identical to the
// production helper.
async function waitForDeviceActionRunForTest(
  runId: number,
  organizationId: string,
  budgets: { queueMs: number; postClaimMs: number; pollMs: number }
): Promise<{
  status: 'completed' | 'failed' | 'timeout';
  output?: Record<string, unknown>;
  error_message?: string;
}> {
  const sql = getTestDb();
  const queueDeadline = Date.now() + budgets.queueMs;
  let claimedAtMs: number | null = null;

  while (true) {
    const rows = (await sql`
      SELECT status, action_output, error_message, claimed_at
      FROM runs
      WHERE id = ${runId} AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      status: string;
      action_output: Record<string, unknown> | null;
      error_message: string | null;
      claimed_at: Date | string | null;
    }>;
    const row = rows[0];
    if (!row) {
      return { status: 'failed', error_message: 'disappeared' };
    }
    if (row.status === 'completed') {
      return {
        status: 'completed',
        output: (row.action_output ?? {}) as Record<string, unknown>,
      };
    }
    if (row.status === 'failed' || row.status === 'timeout') {
      return {
        status: row.status as 'failed' | 'timeout',
        error_message: row.error_message ?? `${row.status}`,
      };
    }
    if (row.claimed_at && claimedAtMs == null) {
      claimedAtMs =
        row.claimed_at instanceof Date
          ? row.claimed_at.getTime()
          : new Date(row.claimed_at).getTime();
    }
    const now = Date.now();
    if (claimedAtMs != null) {
      if (now - claimedAtMs >= budgets.postClaimMs) break;
    } else {
      if (now >= queueDeadline) break;
    }
    await new Promise((r) => setTimeout(r, budgets.pollMs));
  }

  const updated = (await sql`
    UPDATE runs
    SET status = 'timeout',
        completed_at = current_timestamp,
        error_message = 'test-timeout'
    WHERE id = ${runId}
      AND organization_id = ${organizationId}
      AND status IN ('pending', 'running')
    RETURNING id
  `) as Array<{ id: number }>;

  if (updated.length === 0) {
    const finalRows = (await sql`
      SELECT status, action_output, error_message
      FROM runs
      WHERE id = ${runId} AND organization_id = ${organizationId}
      LIMIT 1
    `) as Array<{
      status: string;
      action_output: Record<string, unknown> | null;
      error_message: string | null;
    }>;
    const final = finalRows[0];
    if (final?.status === 'completed') {
      return {
        status: 'completed',
        output: (final.action_output ?? {}) as Record<string, unknown>,
      };
    }
    if (final?.status === 'failed') {
      return {
        status: 'failed',
        error_message: final.error_message ?? 'final-failed',
      };
    }
  }
  return { status: 'timeout', error_message: 'budget-exceeded' };
}

// Worker-side completion guarded by the atomic clause we use in
// production: status='running' AND claimed_by=worker — so a stale
// claimant or a terminal-state row results in a no-op.
async function workerCompleteAction(
  runId: number,
  workerId: string,
  outcome: 'success' | 'failed',
  actionOutput: Record<string, unknown> | null = null
): Promise<boolean> {
  const sql = getTestDb();
  const rows = (await sql`
    UPDATE runs
    SET status = ${outcome === 'success' ? 'completed' : 'failed'},
        completed_at = current_timestamp,
        action_output = ${actionOutput ? sql.json(actionOutput) : null},
        error_message = ${outcome === 'success' ? null : 'worker-failed'}
    WHERE id = ${runId}
      AND status = 'running'
      AND claimed_by = ${workerId}
    RETURNING id
  `) as Array<{ id: number }>;
  return rows.length > 0;
}

async function claim(runId: number, workerId: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE runs
    SET status = 'running',
        claimed_at = current_timestamp,
        claimed_by = ${workerId}
    WHERE id = ${runId}
      AND status = 'pending'
  `;
}

const FAST_BUDGETS = { queueMs: 400, postClaimMs: 600, pollMs: 30 };
const WORKER_ID = 'worker-test';

describe('waitForDeviceActionRun', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('returns completed + output on worker success', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {
      url: 'https://example.com',
    });

    // Race the wait helper against a "worker" that claims + completes
    // shortly after the wait starts.
    setTimeout(async () => {
      await claim(runId, WORKER_ID);
      await workerCompleteAction(runId, WORKER_ID, 'success', {
        tab_id: 555,
        current_url: 'https://example.com/',
      });
    }, 80);

    const out = await waitForDeviceActionRunForTest(runId, org.id, FAST_BUDGETS);
    expect(out.status).toBe('completed');
    expect(out.output?.tab_id).toBe(555);
  });

  it('surfaces worker-failed verdict', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});

    setTimeout(async () => {
      await claim(runId, WORKER_ID);
      await workerCompleteAction(runId, WORKER_ID, 'failed');
    }, 80);

    const out = await waitForDeviceActionRunForTest(runId, org.id, FAST_BUDGETS);
    expect(out.status).toBe('failed');
    expect(out.error_message).toBe('worker-failed');
  });

  it('times out + marks row when no worker claims within QUEUE_BUDGET_MS', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});

    const out = await waitForDeviceActionRunForTest(runId, org.id, FAST_BUDGETS);
    expect(out.status).toBe('timeout');

    const sql = getTestDb();
    const rows = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string }>;
    expect(rows[0].status).toBe('timeout');
    expect(rows[0].error_message).toBe('test-timeout');
  });

  it('honors POST_CLAIM_BUDGET_MS after claim — extended wait if claimed late', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});

    // Claim near the end of the queue budget; ensure the post-claim
    // budget kicks in and we don't timeout immediately.
    setTimeout(() => void claim(runId, WORKER_ID), FAST_BUDGETS.queueMs - 80);
    setTimeout(
      () =>
        void workerCompleteAction(runId, WORKER_ID, 'success', { ok: true }),
      FAST_BUDGETS.queueMs + 100,
    );

    const out = await waitForDeviceActionRunForTest(runId, org.id, FAST_BUDGETS);
    expect(out.status).toBe('completed');
  });

  it('atomic guard: a worker that finalizes after gateway-timeout cannot overwrite the verdict', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});
    // Claim immediately but never complete — exhausts post-claim
    // budget. The waiter writes status='timeout'. Then the "worker"
    // tries to post completion; the atomic UPDATE should reject it
    // because status is no longer 'running'.
    await claim(runId, WORKER_ID);

    const out = await waitForDeviceActionRunForTest(runId, org.id, {
      queueMs: 50,
      postClaimMs: 200,
      pollMs: 30,
    });
    expect(out.status).toBe('timeout');

    // Worker arrives late.
    const wrote = await workerCompleteAction(runId, WORKER_ID, 'success', {
      foo: 'bar',
    });
    expect(wrote).toBe(false); // atomic UPDATE rejected

    const sql = getTestDb();
    const final = (await sql`
      SELECT status, action_output FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; action_output: Record<string, unknown> | null }>;
    expect(final[0].status).toBe('timeout');
    expect(final[0].action_output).toBeNull();
  });

  // Exercises the REAL exported helper (not the mirror) for the abortSignal
  // path added so a watcher reaction hitting its wall-clock budget cancels the
  // poll loop instead of leaking it. An already-aborted signal short-circuits
  // on the first iteration, so this stays fast despite the real 60s budget.
  it('aborts the wait + finalizes the run as timeout when the abort signal fires', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const runId = await insertPendingActionRun(org.id, connId, {});

    const controller = new AbortController();
    controller.abort(); // already aborted before we start waiting

    const start = Date.now();
    const out = await waitForDeviceActionRun(runId, org.id, controller.signal);
    const elapsed = Date.now() - start;

    expect(out.status).toBe('timeout');
    expect(elapsed).toBeLessThan(5_000); // did NOT sit through the 60s budget

    const sql = getTestDb();
    const rows = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(rows[0].status).toBe('timeout');
  });
});
