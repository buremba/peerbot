/**
 * `device_workers` via query_sql must be OWNER-scoped, not org-scoped.
 *
 * The entry exists so an agent can find the UUID that
 * `automations.device_worker_id` takes — previously it had to reconstruct that
 * from a `device_created` lifecycle event. But the table is user-owned
 * (`PRIMARY KEY (user_id, worker_id)`, nullable `organization_id`), and
 * query_sql is member-safe, so scoping it the way every other allowlisted
 * relation is scoped — on the org — would let any member enumerate every
 * colleague's machines: `label` is normally a personal name and `last_seen_at`
 * is a presence feed.
 *
 * This drives the real handler against real Postgres. The unit sibling
 * (scoped-query-device-workers.test.ts) pins the emitted SQL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { querySql } from '../../tools/admin/query_sql';
import type { ToolContext } from '../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

interface Ctx {
  organizationId: string;
  alice: string;
  bob: string;
  aliceDeviceId: string;
  bobDeviceId: string;
  aliceUnattachedId: string;
}

let ctx: Ctx;

function memberCtx(organizationId: string, userId: string): ToolContext {
  return {
    organizationId,
    userId,
    memberRole: 'member',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as unknown as ToolContext;
}

async function registerDevice(opts: {
  userId: string;
  workerId: string;
  label: string;
  organizationId: string | null;
}): Promise<string> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id, agent_kinds)
    VALUES (
      ${opts.userId}, ${opts.workerId}, 'macos', ${sql.json({})}, ${opts.label},
      ${opts.organizationId}, ${'{claude-code}'}::text[]
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(rows[0].id);
}

/** Run a query as one member and return the rows it could see. */
async function runAs(
  userId: string,
  sqlText: string
): Promise<Array<Record<string, unknown>>> {
  const result = (await querySql(
    { sql: sqlText },
    {} as never,
    memberCtx(ctx.organizationId, userId)
  )) as { rows?: Array<Record<string, unknown>>; error?: string };
  if (result.error) throw new Error(`query_sql failed: ${result.error}`);
  return result.rows ?? [];
}

describe('device_workers through query_sql is owner-scoped', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Shared Device Org' });
    const alice = await createTestUser({ email: 'alice-devices@test.example.com' });
    const bob = await createTestUser({ email: 'bob-devices@test.example.com' });
    // Both are ordinary members of the SAME workspace — the exact situation an
    // org-only predicate would leak across.
    await addUserToOrganization(alice.id, org.id, 'member');
    await addUserToOrganization(bob.id, org.id, 'member');

    ctx = {
      organizationId: org.id,
      alice: alice.id,
      bob: bob.id,
      aliceDeviceId: await registerDevice({
        userId: alice.id,
        workerId: 'alice-mac',
        label: "Alice's MacBook Pro",
        organizationId: org.id,
      }),
      bobDeviceId: await registerDevice({
        userId: bob.id,
        workerId: 'bob-mac',
        label: "Bob's MacBook Pro",
        organizationId: org.id,
      }),
      aliceUnattachedId: await registerDevice({
        userId: alice.id,
        workerId: 'alice-laptop',
        label: "Alice's unattached laptop",
        organizationId: null,
      }),
    };
  });

  it('shows a member only their own devices, never a colleague’s', async () => {
    const rows = await runAs(ctx.alice, 'SELECT id, worker_id, label FROM device_workers');
    const workerIds = rows.map((r) => String(r.worker_id)).sort();
    expect(workerIds).toEqual(['alice-laptop', 'alice-mac']);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('bob-mac');
    expect(serialized).not.toContain("Bob's MacBook Pro");
  });

  it('is symmetric — Bob cannot see Alice either', async () => {
    const rows = await runAs(ctx.bob, 'SELECT worker_id FROM device_workers');
    expect(rows.map((r) => String(r.worker_id))).toEqual(['bob-mac']);
  });

  it('does not leak a colleague’s device even when asked for it by id', async () => {
    // The filter has to be in the CTE, not merely in the caller's WHERE — a
    // targeted lookup is exactly how an enumerating query would be written.
    const rows = await runAs(
      ctx.bob,
      `SELECT id, label FROM device_workers WHERE id = '${ctx.aliceDeviceId}'`
    );
    expect(rows).toHaveLength(0);
  });

  it('exposes the id an Automation pin needs', async () => {
    // The point of the entry: this UUID is what automations.device_worker_id
    // takes, and it is the value the agent previously had to dig out of a
    // lifecycle event.
    const rows = await runAs(
      ctx.alice,
      "SELECT id, agent_kinds FROM device_workers WHERE worker_id = 'alice-mac'"
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].id)).toBe(ctx.aliceDeviceId);
    expect(String(rows[0].agent_kinds)).toContain('claude-code');
  });

  it('includes the owner’s unattached device', async () => {
    const rows = await runAs(
      ctx.alice,
      "SELECT id FROM device_workers WHERE worker_id = 'alice-laptop'"
    );
    expect(rows.map((r) => String(r.id))).toEqual([ctx.aliceUnattachedId]);
  });

  it('rejects the excluded columns rather than returning them', async () => {
    // connector_manifests is not in the allowlist, so the query must fail
    // closed at validation rather than silently projecting the column.
    const result = (await querySql(
      { sql: 'SELECT connector_manifests FROM device_workers' },
      {} as never,
      memberCtx(ctx.organizationId, ctx.alice)
    )) as { error?: string; rows?: unknown[] };
    expect(result.error).toBeTruthy();
    expect(result.rows ?? []).toHaveLength(0);
  });
});
