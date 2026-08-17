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
 *   3. timeout-pre-claim: run never claimed before the queue budget →
 *      gateway marks the row 'timeout', returns timeout
 *   4. race: worker posts completion AFTER our timeout decision but
 *      BEFORE we re-read. The atomic UPDATE in completeActionRun
 *      (status='running' AND claimed_by=worker_id guard) must reject
 *      the worker write so the gateway's verdict stands.
 *
 * The tests use real timers; the poll loops stay fast because the budgets are
 * shrunk, not because the clock is stubbed.
 *
 * The abort path calls the production helper directly. The longer phase and
 * race tests use a budget-parameterized mirror so they complete in
 * milliseconds while exercising the same SQL transitions.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_ACTION_QUEUE_BUDGET_MS } from '../../config/intervals';
import { createConnectorOperationRun } from '../../runs/queue-service';
import { waitForDeviceActionRun } from '../../tools/admin/device-action-wait';
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
// in milliseconds instead of minutes. Control flow is identical to the
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

// The late-claim test deliberately schedules its claim near the QUEUE deadline,
// so unlike the tests above its margin has to absorb the claim's round trip to
// Postgres, not just timer drift. Under FAST_BUDGETS that margin was 80ms,
// which a contended CI database blows through: the claim commits after the poll
// that already observed `now >= queueDeadline`, so the wait returns 'timeout'
// and the test reds with `expected 'timeout' to be 'completed'`. These budgets
// keep the claim late in relative terms while widening that margin to 400ms.
// To re-verify, prefix `claim()` with `await sql`SELECT pg_sleep(0.2)``: that is
// 3/3 red on the old 80ms margin and 3/3 green on this one (still green at 0.35).
const LATE_CLAIM_BUDGETS = { queueMs: 1200, postClaimMs: 1800, pollMs: 30 };
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

  it('times out + marks row when no worker claims within the queue budget', async () => {
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

    // Claim late in the queue budget, then complete AFTER the queue deadline
    // has already passed. Only the post-claim budget can carry the wait that
    // far, so a 'completed' verdict is what proves the phase switch happened.
    setTimeout(
      () => void claim(runId, WORKER_ID),
      LATE_CLAIM_BUDGETS.queueMs - 400,
    );
    setTimeout(
      () =>
        void workerCompleteAction(runId, WORKER_ID, 'success', { ok: true }),
      LATE_CLAIM_BUDGETS.queueMs + 300,
    );

    const out = await waitForDeviceActionRunForTest(
      runId,
      org.id,
      LATE_CLAIM_BUDGETS,
    );
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
  // path added so an automation reaction hitting its wall-clock budget cancels the
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

describe('createConnectorOperationRun — ephemeral expires_at semantics', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  async function expiresAtOf(runId: number): Promise<Date | null> {
    const sql = getTestDb();
    const rows = (await sql`
      SELECT expires_at FROM runs WHERE id = ${runId}
    `) as Array<{ expires_at: Date | null }>;
    return rows[0]?.expires_at ?? null;
  }

  it('device-mode (ephemeral browser/device) runs get a bounded expires_at', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);

    const createdBefore = Date.now();
    const claim = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device',
      requireCompiledCode: false,
    });
    expect(claim.status).toBe('pending');
    expect(claim.approvalStatus).toBe('auto');

    const expiresAt = await expiresAtOf(claim.runId);
    expect(expiresAt).not.toBeNull();
    const expiresInMs = (expiresAt as Date).getTime() - createdBefore;
    expect(expiresInMs).toBeGreaterThan(DEVICE_ACTION_QUEUE_BUDGET_MS - 5_000);
    expect(expiresInMs).toBeLessThan(DEVICE_ACTION_QUEUE_BUDGET_MS + 5_000);
  });

  it('queued (durable human-decision) runs get NO expires_at', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);

    const claim = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'queued',
      requireCompiledCode: false,
      idempotencyKey: `durable-${Date.now()}`,
    });
    expect(claim.approvalStatus).toBe('pending');
    expect(await expiresAtOf(claim.runId)).toBeNull();
  });

  it('inline (immediate gateway-executed) runs get NO expires_at', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);

    const claim = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'inline',
      requireCompiledCode: false,
      idempotencyKey: `inline-${Date.now()}`,
    });
    expect(claim.status).toBe('running');
    expect(await expiresAtOf(claim.runId)).toBeNull();
  });

  it('an idempotent replay of an expired device run returns the prior terminal row', async () => {
    const org = await createTestOrganization();
    await insertChromeConnector(org.id);
    const connId = await insertChromeConnection(org.id);
    const key = `replay-${Date.now()}`;

    const first = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device',
      requireCompiledCode: false,
      idempotencyKey: key,
    });
    expect(first.created).toBe(true);

    // Age the run to terminal timeout with a lapsed expiry (as the reaper or
    // waitForDeviceActionRun would after the claim horizon).
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET status = 'timeout',
          completed_at = current_timestamp,
          expires_at = now() - interval '1 second'
      WHERE id = ${first.runId}
    `;

    // The same idempotency key must not mint a second run, and must return the
    // prior (now terminal) run rather than resurrecting it.
    const replay = await createConnectorOperationRun({
      organizationId: org.id,
      connectionId: connId,
      connectorKey: 'chrome',
      operationKey: 'open_tab',
      operationInput: { url: 'about:blank' },
      approvalMode: 'device',
      requireCompiledCode: false,
      idempotencyKey: key,
    });
    expect(replay.created).toBe(false);
    expect(replay.runId).toBe(first.runId);
    expect(replay.status).toBe('timeout');
  });
});
