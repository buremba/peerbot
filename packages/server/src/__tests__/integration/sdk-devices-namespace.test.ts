/**
 * `client.devices.list()` through the REAL ClientSDK against real Postgres.
 *
 * The unit sibling (sandbox/namespaces/__tests__/devices-namespace.test.ts)
 * mocks the query to pin delegation and the no-principal guard. This one wires
 * the actual surface: buildClientSDK → the namespace → queryDeviceWorkers →
 * Postgres, because a namespace that is never constructed by the real builder
 * is a feature that does not exist.
 *
 * The property under test is owner scoping. `device_workers` is keyed
 * `(user_id, worker_id)` with a nullable `organization_id` that records where a
 * device is ATTACHED, not who owns it — so two members of ONE org must not see
 * each other's machines through the SDK.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { buildClientSDK } from '../../sandbox/client-sdk';
import type { ToolContext } from '../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

const env = { ENVIRONMENT: 'test' } as Env;

let organizationId: string;
let aliceId: string;
let bobId: string;
let aliceDeviceId: string;

function sdkFor(userId: string | null) {
  return buildClientSDK(
    {
      organizationId,
      userId,
      memberRole: 'member',
      isAuthenticated: true,
      scopes: ['mcp:read', 'mcp:write'],
    } as unknown as ToolContext,
    env
  );
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

describe('client.devices.list() is owner-scoped', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'SDK Device Org' });
    const alice = await createTestUser({ email: 'alice-sdk-dev@test.example.com' });
    const bob = await createTestUser({ email: 'bob-sdk-dev@test.example.com' });
    await addUserToOrganization(alice.id, org.id, 'member');
    await addUserToOrganization(bob.id, org.id, 'member');

    organizationId = org.id;
    aliceId = alice.id;
    bobId = bob.id;
    aliceDeviceId = await registerDevice({
      userId: alice.id,
      workerId: 'alice-mac',
      label: "Alice's MacBook Pro",
      organizationId: org.id,
    });
    await registerDevice({
      userId: bob.id,
      workerId: 'bob-mac',
      label: "Bob's MacBook Pro",
      organizationId: org.id,
    });
    // Attached to NO workspace: still Alice's, and still pinnable by her, so the
    // list must include it rather than hide a device she can pin.
    await registerDevice({
      userId: alice.id,
      workerId: 'alice-laptop',
      label: "Alice's unattached laptop",
      organizationId: null,
    });
  });

  it('exposes a devices namespace on the real SDK object', () => {
    // Guards the wiring itself: buildClientSDK must actually construct it.
    const sdk = sdkFor(aliceId);
    expect(typeof sdk.devices?.list).toBe('function');
  });

  it("returns only the caller's devices, never a colleague's", async () => {
    const devices = await sdkFor(aliceId).devices.list();
    expect(devices.map((d) => d.worker_id).sort()).toEqual([
      'alice-laptop',
      'alice-mac',
    ]);
    const serialized = JSON.stringify(devices);
    expect(serialized).not.toContain('bob-mac');
    expect(serialized).not.toContain("Bob's MacBook Pro");
  });

  it('is symmetric — Bob sees only his own', async () => {
    const devices = await sdkFor(bobId).devices.list();
    expect(devices.map((d) => d.worker_id)).toEqual(['bob-mac']);
  });

  it('surfaces the id and agent_kinds an Automation pin needs', async () => {
    const devices = await sdkFor(aliceId).devices.list();
    const mac = devices.find((d) => d.worker_id === 'alice-mac');
    // This id is the whole point: automations.device_worker_id takes it.
    expect(mac?.id).toBe(aliceDeviceId);
    expect(mac?.agent_kinds).toEqual(['claude-code']);
  });

  it('returns nothing for a context with no principal', async () => {
    // A system/service caller owns no devices; returning none is fail-closed.
    expect(await sdkFor(null).devices.list()).toEqual([]);
  });
});
