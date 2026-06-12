/**
 * Watcher CRUD via the post-#348 SDK surface.
 *
 * Replaces the deleted manage_watchers integration tests. Covers create,
 * read, update, delete on watchers attached to an entity, plus access-control
 * around the destructive actions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

describe('watcher CRUD', () => {
  let owner: TestApiClient;
  let intruder: TestApiClient;
  let entityId: number;
  let agentId: string;
  let ownerOrgId: string;
  let ownerUserId: string;
  let otherOrgId: string;
  let otherUserId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Watcher Test Org' });
    const user = await createTestUser({ email: 'watcher-owner@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    ownerOrgId = org.id;
    ownerUserId = user.id;
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    agentId = agent.agentId;

    const otherOrg = await createTestOrganization({ name: 'Watcher Other Org' });
    const otherUser = await createTestUser({ email: 'watcher-other@test.com' });
    await addUserToOrganization(otherUser.id, otherOrg.id, 'owner');
    otherOrgId = otherOrg.id;
    otherUserId = otherUser.id;
    intruder = await TestApiClient.for({
      organizationId: otherOrg.id,
      userId: otherUser.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    const entity = (await owner.entities.create({
      type: 'company',
      name: 'Watcher Target',
    })) as { entity: { id: number } };
    entityId = entity.entity.id;
  });

  it('creates → reads back → updates → deletes a watcher', async () => {
    const created = (await owner.watchers.create({
      entity_id: entityId,
      slug: 'lifecycle-watcher',
      name: 'Lifecycle Watcher',
      prompt: 'Track product launches.',
      extraction_schema: {
        type: 'object',
        properties: { launches: { type: 'array', items: { type: 'string' } } },
      },
      schedule: '0 9 * * *',
      agent_id: agentId,
    })) as { watcher_id: string };
    const watcherId = created.watcher_id;
    expect(watcherId).toBeDefined();

    const got = (await owner.watchers.get(watcherId)) as {
      watcher?: { watcher_name: string };
    };
    expect(got.watcher?.watcher_name).toBe('Lifecycle Watcher');

    await owner.watchers.update({ watcher_id: watcherId, schedule: '0 10 * * *' });
    const after = (await owner.watchers.get(watcherId)) as {
      watcher?: { schedule: string | null };
    };
    expect(after.watcher?.schedule).toBe('0 10 * * *');

    await owner.watchers.delete([watcherId]);
    const list = (await owner.watchers.list({ entity_id: entityId })) as {
      watchers?: Array<{ watcher_id: string }>;
    };
    expect(list.watchers?.some((w) => w.watcher_id === watcherId)).toBe(false);
  });

  it('round-trips execution_config through create → list → update', async () => {
    const created = (await owner.watchers.create({
      entity_id: entityId,
      slug: 'exec-config-watcher',
      name: 'Exec Config Watcher',
      prompt: 'Track things.',
      extraction_schema: { type: 'object', properties: {} },
      agent_id: agentId,
      execution_config: {
        timeout_seconds: 1800,
        max_budget_usd: 2.5,
        model: 'opus',
        permission_mode: 'acceptEdits',
        effort: 'high',
      },
    })) as { watcher_id: string };
    const watcherId = created.watcher_id;

    const findRow = (
      res: {
        watchers?: Array<{ watcher_id: string; execution_config?: Record<string, unknown> | null }>;
      },
      id: string
    ) => res.watchers?.find((w) => String(w.watcher_id) === String(id));

    const list = (await owner.watchers.list({ entity_id: entityId })) as {
      watchers?: Array<{ watcher_id: string; execution_config?: Record<string, unknown> }>;
    };
    expect(findRow(list, watcherId)?.execution_config).toEqual({
      timeout_seconds: 1800,
      max_budget_usd: 2.5,
      model: 'opus',
      permission_mode: 'acceptEdits',
      effort: 'high',
    });

    // Update replaces the whole jsonb; a partial object is stored verbatim.
    await owner.watchers.update({
      watcher_id: watcherId,
      execution_config: { timeout_seconds: 300 },
    });
    const after = (await owner.watchers.list({ entity_id: entityId })) as {
      watchers?: Array<{ watcher_id: string; execution_config?: Record<string, unknown> }>;
    };
    expect(findRow(after, watcherId)?.execution_config).toEqual({ timeout_seconds: 300 });

    // Passing null clears the saved config back to NULL/defaults.
    await owner.watchers.update({ watcher_id: watcherId, execution_config: null });
    const cleared = (await owner.watchers.list({ entity_id: entityId })) as {
      watchers?: Array<{ watcher_id: string; execution_config?: Record<string, unknown> | null }>;
    };
    expect(findRow(cleared, watcherId)?.execution_config ?? null).toBeNull();

    await owner.watchers.delete([watcherId]);
  });

  it('leaves execution_config null when unset', async () => {
    const created = (await owner.watchers.create({
      entity_id: entityId,
      slug: 'no-exec-config-watcher',
      name: 'No Exec Config',
      prompt: 'Track things.',
      extraction_schema: { type: 'object', properties: {} },
      agent_id: agentId,
    })) as { watcher_id: string };

    const list = (await owner.watchers.list({ entity_id: entityId })) as {
      watchers?: Array<{ watcher_id: string; execution_config?: Record<string, unknown> | null }>;
    };
    const row = list.watchers?.find(
      (w) => String(w.watcher_id) === String(created.watcher_id)
    );
    expect(row).toBeDefined();
    expect(row?.execution_config ?? null).toBeNull();

    await owner.watchers.delete([created.watcher_id]);
  });

  it('rejects an invalid execution_config (type/range/unknown-key)', async () => {
    const base = {
      entity_id: entityId,
      name: 'Bad Exec',
      prompt: 'x',
      extraction_schema: { type: 'object', properties: {} },
      agent_id: agentId,
    };
    // timeout_seconds below minimum
    await expect(
      owner.watchers.create({ ...base, slug: 'bad-1', execution_config: { timeout_seconds: 0 } })
    ).rejects.toThrow(/execution_config/i);
    // uncoercible type (non-numeric string where integer expected) — would
    // otherwise brick the Swift payload decode at run time. A numeric string
    // like '600' is coerced to 600 by boundary validation instead.
    await expect(
      owner.watchers.create({
        ...base,
        slug: 'bad-2',
        execution_config: { timeout_seconds: 'abc' },
      } as never)
    ).rejects.toThrow(/execution_config/i);
    // unknown key (additionalProperties: false)
    await expect(
      owner.watchers.create({
        ...base,
        slug: 'bad-3',
        execution_config: { bogus: true },
      } as never)
    ).rejects.toThrow(/execution_config/i);
    // above maximum
    await expect(
      owner.watchers.create({
        ...base,
        slug: 'bad-4',
        execution_config: { timeout_seconds: 999_999 },
      })
    ).rejects.toThrow(/execution_config/i);
  });

  it('creates an org-scoped watcher with no entity_id', async () => {
    const created = (await owner.watchers.create({
      slug: 'org-scoped-watcher',
      name: 'Org Scoped',
      prompt: 'Track org-wide signals.',
      extraction_schema: {
        type: 'object',
        properties: { signals: { type: 'array', items: { type: 'string' } } },
      },
      agent_id: agentId,
    })) as { watcher_id: string };
    expect(created.watcher_id).toBeDefined();

    const got = (await owner.watchers.get(created.watcher_id)) as {
      watcher?: { entity_ids?: number[] };
    };
    expect(got.watcher?.entity_ids ?? []).toEqual([]);

    await owner.watchers.delete([created.watcher_id]);
  });

  it('rejects an org-scoped watcher when there is no organization context', async () => {
    const noOrg = owner.withAuth({ organizationId: null });
    await expect(
      noOrg.watchers.create({
        slug: 'no-org-watcher',
        name: 'No Org',
        prompt: 'should fail',
        extraction_schema: { type: 'object', properties: {} },
        agent_id: agentId,
      })
    ).rejects.toThrow(/organization|entity_id/i);
  });

  it('blocks cross-org reads and writes for org-scoped watchers', async () => {
    const created = (await owner.watchers.create({
      slug: 'cross-org-org-scoped-watcher',
      name: 'Cross Org Protected',
      prompt: 'Track org-wide signals.',
      extraction_schema: {
        type: 'object',
        properties: { signals: { type: 'array', items: { type: 'string' } } },
      },
      agent_id: agentId,
    })) as { watcher_id: string };

    await expect(intruder.watchers.get(created.watcher_id)).rejects.toThrow(
      /access|organization/i
    );
    await expect(
      intruder.watchers.update({
        watcher_id: created.watcher_id,
        schedule: '0 11 * * *',
      })
    ).rejects.toThrow(/access|organization/i);
    await expect(intruder.watchers.delete([created.watcher_id])).rejects.toThrow(
      /access|organization/i
    );

    const got = (await owner.watchers.get(created.watcher_id)) as {
      watcher?: { schedule: string | null };
    };
    expect(got.watcher?.schedule).toBeNull();

    await owner.watchers.delete([created.watcher_id]);
  });

  it('blocks a member from deleting watchers (admin-only)', async () => {
    const created = (await owner.watchers.create({
      entity_id: entityId,
      slug: 'protected-watcher',
      name: 'Protected',
      prompt: 'guarded.',
      extraction_schema: {
        type: 'object',
        properties: { signal: { type: 'string' } },
      },
      agent_id: agentId,
    })) as { watcher_id: string };

    const member = owner.withAuth({ memberRole: 'member' });
    await expect(member.watchers.delete([created.watcher_id])).rejects.toThrow(
      /admin|owner|access/i
    );
  });

  // Issue #1060: a device pin (watchers.device_worker_id) runs the watcher's
  // agent CLI on the device owner's machine, so create/update must verify the
  // caller may target that device. The exhaustive role × ownership matrix is in
  // src/__tests__/unit/watcher-device-access.test.ts; this proves the gate is
  // wired into the handlers end-to-end (device_worker_id only reaches the
  // handler via the raw `manage()` escape hatch — the typed input omits it).
  describe('device_worker_id ownership gate', () => {
    async function seedDevice(opts: {
      userId: string;
      organizationId: string | null;
      worker: string;
    }): Promise<string> {
      const sql = getTestDb();
      const rows = (await sql`
        INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
        VALUES (${opts.userId}, ${opts.worker}, 'macos', ${sql.json([])}, 'Seed Device', ${opts.organizationId})
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      return String(rows[0].id);
    }

    it('lets an org owner pin a foreign device attached to their org', async () => {
      // A different user's device, but it lives in the owner's org → allowed
      // for an owner/admin role.
      const deviceId = await seedDevice({
        userId: otherUserId,
        organizationId: ownerOrgId,
        worker: 'dev-in-org',
      });
      const created = (await owner.watchers.manage({
        action: 'create',
        entity_id: entityId,
        slug: 'device-pin-allowed',
        name: 'Device Pin Allowed',
        prompt: 'x',
        extraction_schema: { type: 'object', properties: {} },
        agent_id: agentId,
        device_worker_id: deviceId,
      })) as { watcher_id: string };
      expect(created.watcher_id).toBeDefined();

      const got = (await owner.watchers.get(created.watcher_id)) as {
        watcher?: { device_worker_id?: string | null };
      };
      expect(got.watcher?.device_worker_id).toBe(deviceId);
      await owner.watchers.delete([created.watcher_id]);
    });

    it("rejects pinning to a device in another org (create)", async () => {
      // Device owned by another user AND attached to another org — even an owner
      // cannot pin it; this is the privilege-escalation case.
      const foreignDeviceId = await seedDevice({
        userId: otherUserId,
        organizationId: otherOrgId,
        worker: 'dev-foreign-org',
      });
      await expect(
        owner.watchers.manage({
          action: 'create',
          entity_id: entityId,
          slug: 'device-pin-foreign',
          name: 'Device Pin Foreign',
          prompt: 'x',
          extraction_schema: { type: 'object', properties: {} },
          agent_id: agentId,
          device_worker_id: foreignDeviceId,
        })
      ).rejects.toThrow(/device you own|not found or not accessible/i);
    });

    it('rejects pinning to a nonexistent device (create)', async () => {
      await expect(
        owner.watchers.manage({
          action: 'create',
          entity_id: entityId,
          slug: 'device-pin-missing',
          name: 'Device Pin Missing',
          prompt: 'x',
          extraction_schema: { type: 'object', properties: {} },
          agent_id: agentId,
          device_worker_id: '00000000-0000-0000-0000-000000000000',
        })
      ).rejects.toThrow(/not found or not accessible/i);
    });

    it('rejects re-pinning an existing watcher to a foreign-org device (update)', async () => {
      const created = (await owner.watchers.create({
        entity_id: entityId,
        slug: 'device-pin-update',
        name: 'Device Pin Update',
        prompt: 'x',
        extraction_schema: { type: 'object', properties: {} },
        agent_id: agentId,
      })) as { watcher_id: string };

      const foreignDeviceId = await seedDevice({
        userId: otherUserId,
        organizationId: otherOrgId,
        worker: 'dev-foreign-update',
      });
      await expect(
        owner.watchers.manage({
          action: 'update',
          watcher_id: created.watcher_id,
          device_worker_id: foreignDeviceId,
        })
      ).rejects.toThrow(/device you own|not found or not accessible/i);

      await owner.watchers.delete([created.watcher_id]);
    });
  });
});
