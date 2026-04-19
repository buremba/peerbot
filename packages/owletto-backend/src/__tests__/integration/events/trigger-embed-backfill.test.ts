/**
 * Trigger Embed Backfill Integration Tests
 *
 * Verifies that scheduled backfill run creation is race-safe and organization-scoped.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { triggerEmbedBackfill } from '../../../scheduled/trigger-embed-backfill';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('triggerEmbedBackfill', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
  });

  it('creates one pending embed_backfill run with event_ids payload', async () => {
    const sql = getTestDb();

    const org = await createTestOrganization({ name: 'Backfill Org' });
    const user = await createTestUser({ email: 'backfill-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const entity = await createTestEntity({
      name: 'Backfill Entity',
      organization_id: org.id,
    });

    await createTestEvent({ entity_id: entity.id, content: 'Missing embedding 1' });
    await createTestEvent({ entity_id: entity.id, content: 'Missing embedding 2' });
    await createTestEvent({ entity_id: entity.id, content: 'Missing embedding 3' });

    const result = await triggerEmbedBackfill({} as Env);

    expect(result.organizations).toBe(1);
    expect(result.runsCreated).toBe(1);
    expect(result.totalEvents).toBe(3);

    const runs = await sql`
      SELECT id, organization_id, run_type, status, action_input
      FROM runs
      WHERE run_type = 'embed_backfill'
        AND organization_id = ${org.id}
    `;

    expect(runs.length).toBe(1);
    expect(String(runs[0].status)).toBe('pending');

    const rawActionInput = (runs[0] as { action_input: unknown }).action_input;
    const actionInput =
      typeof rawActionInput === 'string'
        ? (JSON.parse(rawActionInput) as { event_ids?: unknown })
        : (rawActionInput as { event_ids?: unknown });
    expect(Array.isArray(actionInput?.event_ids)).toBe(true);
    expect((actionInput.event_ids as unknown[]).length).toBe(3);
  });

  it('prevents duplicate active embed_backfill runs under concurrent scheduler ticks', async () => {
    const sql = getTestDb();

    const org = await createTestOrganization({ name: 'Concurrent Backfill Org' });
    const user = await createTestUser({ email: 'concurrent-backfill-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const entity = await createTestEntity({
      name: 'Concurrent Backfill Entity',
      organization_id: org.id,
    });

    for (let i = 0; i < 8; i++) {
      await createTestEvent({ entity_id: entity.id, content: `Concurrent event ${i}` });
    }

    const [resultA, resultB] = await Promise.all([
      triggerEmbedBackfill({} as Env),
      triggerEmbedBackfill({} as Env),
    ]);

    const activeRuns = await sql`
      SELECT id
      FROM runs
      WHERE organization_id = ${org.id}
        AND run_type = 'embed_backfill'
        AND status IN ('pending', 'running')
    `;

    expect(activeRuns.length).toBe(1);
    expect(resultA.runsCreated + resultB.runsCreated).toBe(1);
  });
});
