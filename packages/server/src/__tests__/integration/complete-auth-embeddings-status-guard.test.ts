/**
 * completeAuthRun / completeEmbeddings status-guard reproducer.
 *
 * Bug (F2): both handlers finalized their run with a bare `WHERE id = run_id`
 * UPDATE — no `status = 'running'` / `claimed_by = worker_id` guard, and
 * completeEmbeddings never called authorizeRunForWorker at all. So a worker
 * reporting in AFTER the gateway already reaped the run on timeout would:
 *   - resurrect the terminal run, and
 *   - re-apply the downstream side effects: completeAuthRun would flip the
 *     linked auth_profile to 'active' (re-activating a credential the timeout
 *     path had already torn down), and completeEmbeddings would write the
 *     embedding rows for a run that no longer exists logically.
 *
 * The fix mirrors completeWorkerJob/completeActionRun: the terminal UPDATE
 * carries `AND status = 'running' AND claimed_by = worker_id` + RETURNING, and
 * on a 0-row match the handler short-circuits with an idempotent
 * `already_finalized` response BEFORE touching auth_profiles / event_embeddings.
 *
 * Red (pre-fix): the late completion flips the run status away from 'timeout'
 * AND applies the side effects. Green (post-fix): status stays 'timeout', side
 * effects are untouched, handler returns { success: false,
 * reason: 'already_finalized' }.
 *
 * Drives the REAL exported handlers against the embedded DB via a minimal Hono
 * Context (same approach as complete-worker-job-status-guard.test.ts). The mock
 * context has no workerAuthMode, so authorizeRunForWorker is a no-op — which
 * isolates the guard under test to each handler's own UPDATE, exactly as the
 * timeout race would in production (the status flips AFTER
 * authorizeRunForWorker's read, in the TOCTOU window before the UPDATE).
 */

import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { completeAuthRun, completeEmbeddings } from '../../worker-api';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const WORKER_ID = 'worker-late';

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    var: {},
    json: (b: unknown, status?: number) => {
      captured = { body: b, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

async function insertPendingAuthProfile(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO auth_profiles
      (organization_id, slug, display_name, connector_key, profile_kind, status,
       created_at, updated_at)
    VALUES
      (${organizationId}, 'gmail-guard-test', 'Gmail Guard Test', 'gmail',
       'oauth_account', 'pending_auth', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

/**
 * Seed an AUTH run already reaped on timeout (status='timeout', still bearing
 * WORKER_ID's claim) — the exact shape after the gateway's timeout reaper
 * flipped the status while the worker was still running.
 */
async function insertReapedAuthRun(
  organizationId: string,
  authProfileId: number
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, auth_profile_id, connector_key, connector_version,
       status, claimed_by, claimed_at, completed_at, error_message, created_at)
    VALUES
      (${organizationId}, 'auth', ${authProfileId}, 'gmail', '0.1.0',
       'timeout', ${WORKER_ID}, NOW(), NOW(), 'reaped-on-timeout', NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertReapedEmbedRun(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, status, claimed_by, claimed_at, completed_at,
       error_message, created_at)
    VALUES
      (${organizationId}, 'embed_backfill', 'timeout', ${WORKER_ID}, NOW(), NOW(),
       'reaped-on-timeout', NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertEvent(organizationId: string): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO events
      (organization_id, payload_text, semantic_type, occurred_at, created_at)
    VALUES
      (${organizationId}, 'embed me', 'note', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

describe('completeAuthRun status guard (late-completion-after-timeout)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('does NOT resurrect a reaped auth run or re-activate the auth profile on late success', async () => {
    const org = await createTestOrganization();
    const profileId = await insertPendingAuthProfile(org.id);
    const runId = await insertReapedAuthRun(org.id, profileId);
    const sql = getTestDb();

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      credentials: { access_token: 'late-token' },
      metadata: { foo: 'bar' },
    });
    await completeAuthRun(ctx);

    // Idempotent no-op response.
    expect(result().body).toEqual({ success: false, reason: 'already_finalized' });

    // Run stays terminal/timeout — NOT resurrected to 'completed'.
    const runAfter = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string | null }>;
    expect(runAfter[0].status).toBe('timeout');
    expect(runAfter[0].error_message).toBe('reaped-on-timeout');

    // Auth profile side effects NEVER applied: still pending_auth, no creds.
    const profileAfter = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;
    expect(profileAfter[0].status).toBe('pending_auth');
    expect(profileAfter[0].auth_data).toEqual({});
  });

  it('rejects a late auth completion from a DIFFERENT worker than the claimant', async () => {
    const org = await createTestOrganization();
    const profileId = await insertPendingAuthProfile(org.id);
    const sql = getTestDb();
    // A genuinely running auth run claimed by WORKER_ID.
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, auth_profile_id, connector_key, connector_version,
         status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'auth', ${profileId}, 'gmail', '0.1.0',
         'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: 'some-other-worker',
      status: 'success',
      credentials: { access_token: 'stolen' },
    });
    await completeAuthRun(ctx);

    expect(result().body).toEqual({ success: false, reason: 'already_finalized' });

    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('running'); // untouched

    const profileAfter = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;
    expect(profileAfter[0].status).toBe('pending_auth');
    expect(profileAfter[0].auth_data).toEqual({});
  });

  it('still finalizes a genuinely running auth run + activates the profile once', async () => {
    const org = await createTestOrganization();
    const profileId = await insertPendingAuthProfile(org.id);
    const sql = getTestDb();
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, auth_profile_id, connector_key, connector_version,
         status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'auth', ${profileId}, 'gmail', '0.1.0',
         'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      credentials: { access_token: 'fresh' },
    });
    await completeAuthRun(ctx);

    expect(result().body).toEqual({ success: true });

    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('completed');

    const profileAfter = (await sql`
      SELECT status, auth_data FROM auth_profiles WHERE id = ${profileId}
    `) as Array<{ status: string; auth_data: Record<string, unknown> }>;
    expect(profileAfter[0].status).toBe('active');
    expect(profileAfter[0].auth_data).toEqual({ access_token: 'fresh' });
  });
});

describe('completeEmbeddings status guard (late-completion-after-timeout)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('does NOT resurrect a reaped embed run, but still writes the idempotent embedding', async () => {
    const org = await createTestOrganization();
    const eventId = await insertEvent(org.id);
    const runId = await insertReapedEmbedRun(org.id);
    const sql = getTestDb();

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      embeddings: [
        { event_id: eventId, embedding: Array.from({ length: 768 }, () => 0.1), embedding_model: 'test-model' },
      ],
    });
    await completeEmbeddings(ctx);

    // The embedding upsert is the handler's real job (idempotent, ownership-gated
    // by authorizeRunForWorker) and runs regardless of the run state — this is the
    // same path headless backfills use with run_id=-1.
    expect(result().body).toEqual({ success: true, updated: 1 });

    // But the run is NOT resurrected — the finalizeRun status guard leaves the
    // reaped run terminal.
    const runAfter = (await sql`
      SELECT status FROM runs WHERE id = ${runId}
    `) as Array<{ status: string }>;
    expect(runAfter[0].status).toBe('timeout');

    // The embedding was written for the event.
    const embRows = (await sql`
      SELECT event_id FROM event_embeddings WHERE event_id = ${eventId}
    `) as Array<{ event_id: number }>;
    expect(embRows.length).toBe(1);
  });

  it('does NOT resurrect a reaped embed run on late empty/error completion', async () => {
    const org = await createTestOrganization();
    const runId = await insertReapedEmbedRun(org.id);
    const sql = getTestDb();

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      embeddings: [],
      error_message: 'embed failed late',
    });
    await completeEmbeddings(ctx);

    // The error response echoes the submitted message; the run transition is a
    // guarded no-op so the reaped run is NOT resurrected.
    expect(result().body).toEqual({ success: false, error: 'embed failed late' });

    const runAfter = (await sql`
      SELECT status, error_message FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; error_message: string | null }>;
    expect(runAfter[0].status).toBe('timeout');
    expect(runAfter[0].error_message).toBe('reaped-on-timeout');
  });

  it('still finalizes a genuinely running embed run + writes embeddings once', async () => {
    const org = await createTestOrganization();
    const eventId = await insertEvent(org.id);
    const sql = getTestDb();
    const runRows = (await sql`
      INSERT INTO runs
        (organization_id, run_type, status, claimed_by, claimed_at, created_at)
      VALUES
        (${org.id}, 'embed_backfill', 'running', ${WORKER_ID}, NOW(), NOW())
      RETURNING id
    `) as Array<{ id: number }>;
    const runId = runRows[0].id;

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      embeddings: [
        { event_id: eventId, embedding: Array.from({ length: 768 }, () => 0.2), embedding_model: 'test-model' },
      ],
    });
    await completeEmbeddings(ctx);

    expect(result().body).toEqual({ success: true, updated: 1 });

    const runAfter = (await sql`
      SELECT status, items_collected FROM runs WHERE id = ${runId}
    `) as Array<{ status: string; items_collected: number | string }>;
    expect(runAfter[0].status).toBe('completed');
    expect(Number(runAfter[0].items_collected)).toBe(1);

    const embRows = (await sql`
      SELECT embedding_model FROM event_embeddings WHERE event_id = ${eventId}
    `) as Array<{ embedding_model: string }>;
    expect(embRows.length).toBe(1);
    expect(embRows[0].embedding_model).toBe('test-model');
  });
});
