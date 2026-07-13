/**
 * DB-egress hardening capability negotiation (PR #1896):
 *
 * A `postgres` (and future warehouse) run opens a raw tenant DB socket and
 * relies on the connector-worker subprocess enforcing block-private egress
 * (resolve-then-pin IP, DNS-rebind guard, forced TLS). During a rolling deploy
 * a NEW gateway must NOT hand such a claimed run to an OLD fleet worker that
 * predates the hardening — that worker ignores `db_egress_policy` and would
 * reopen private-IP/plaintext egress.
 *
 * The gateway therefore refuses, in cloud mode, to dispatch a DB-egress-hardened
 * connector run to a fleet worker that does NOT advertise `db_egress_hardening`.
 * The run stays pending until a new worker (which advertises it) claims it.
 * Self-hosted (non-cloud) mode is unaffected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';

async function seedOrg() {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-egress-${generateSecureToken(4)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Egress Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${orgId}, 'Egress Org', ${orgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  return { userId, orgId };
}

async function seedConnection(opts: {
  orgId: string;
  userId: string;
  connectorKey: string;
}): Promise<number> {
  const sql = getTestDb();
  const slug = `${opts.connectorKey}-${generateSecureToken(4)}`.replace(/\./g, '-');
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      created_by, visibility, created_at, updated_at
    ) VALUES (
      ${opts.orgId}, ${opts.connectorKey}, ${slug}, ${opts.connectorKey}, 'active',
      ${opts.userId}, 'private', NOW(), NOW()
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function seedPendingSync(opts: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, connection_id, connector_key,
      approval_status, status, created_at
    ) VALUES (
      ${opts.orgId}, 'sync', ${opts.connectionId}, ${opts.connectorKey},
      'auto', 'pending', current_timestamp
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function pollFleet(opts: {
  workerId: string;
  hardened: boolean;
}) {
  return post('/api/workers/poll', {
    body: {
      worker_id: opts.workerId,
      capabilities: opts.hardened ? { db_egress_hardening: true } : {},
    },
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

async function runStatus(runId: number) {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT status, claimed_by FROM runs WHERE id = ${runId}
  `) as unknown as Array<{ status: string; claimed_by: string | null }>;
  return row;
}

describe('DB-egress capability claim negotiation', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });
  afterEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });

  it('cloud mode: OLD fleet worker (no db_egress_hardening) does NOT claim a postgres run', async () => {
    process.env.LOBU_CLOUD_MODE = '1';
    const { userId, orgId } = await seedOrg();
    const connId = await seedConnection({ orgId, userId, connectorKey: 'postgres' });
    const runId = await seedPendingSync({ orgId, connectionId: connId, connectorKey: 'postgres' });

    const res = await pollFleet({ workerId: 'old-fleet-worker', hardened: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number; skipped_run_id?: number };
    expect(body.run_id).toBeUndefined();
    expect(body.skipped_run_id).toBeUndefined();

    const row = await runStatus(runId);
    expect(row.status).toBe('pending');
    expect(row.claimed_by).toBeNull();
  });

  it('cloud mode: NEW fleet worker (db_egress_hardening) DOES claim a postgres run', async () => {
    process.env.LOBU_CLOUD_MODE = '1';
    const { userId, orgId } = await seedOrg();
    const connId = await seedConnection({ orgId, userId, connectorKey: 'postgres' });
    const runId = await seedPendingSync({ orgId, connectionId: connId, connectorKey: 'postgres' });

    const res = await pollFleet({ workerId: 'new-fleet-worker', hardened: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number; skipped_run_id?: number };
    // Claimed. Without on-disk postgres sources the poll may fail-after-claim
    // with skipped_run_id — either proves the claim happened.
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const row = await runStatus(runId);
    expect(row.claimed_by).toBe('new-fleet-worker');
  });

  it('non-cloud mode: OLD fleet worker (no capability) DOES claim a postgres run (self-host no-op)', async () => {
    delete process.env.LOBU_CLOUD_MODE;
    const { userId, orgId } = await seedOrg();
    const connId = await seedConnection({ orgId, userId, connectorKey: 'postgres' });
    const runId = await seedPendingSync({ orgId, connectionId: connId, connectorKey: 'postgres' });

    const res = await pollFleet({ workerId: 'selfhost-fleet-worker', hardened: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number; skipped_run_id?: number };
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const row = await runStatus(runId);
    expect(row.claimed_by).toBe('selfhost-fleet-worker');
  });

  it('cloud mode: OLD fleet worker still claims a NON-hardened connector run (no over-block)', async () => {
    process.env.LOBU_CLOUD_MODE = '1';
    const { userId, orgId } = await seedOrg();
    const connId = await seedConnection({ orgId, userId, connectorKey: 'linkedin' });
    const runId = await seedPendingSync({ orgId, connectionId: connId, connectorKey: 'linkedin' });

    const res = await pollFleet({ workerId: 'old-fleet-nonhardened', hardened: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run_id?: number; skipped_run_id?: number };
    const claimedId = Number(body.run_id ?? body.skipped_run_id);
    expect(claimedId).toBe(runId);

    const row = await runStatus(runId);
    expect(row.claimed_by).toBe('old-fleet-nonhardened');
  });
});
