/**
 * Entity Change Events Test
 *
 * Verifies that updating entity fields records a 'change' event
 * in the events table for audit trail purposes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { manageEntity } from '../../../tools/admin/manage_entity';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('Entity Change Events', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let ctx: ToolContext;
  const env = {} as any;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    await initWorkspaceProvider();

    org = await createTestOrganization({ name: 'Change Event Test Org' });
    user = await createTestUser({ email: 'change-event-user@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    await createTestAccessToken(user.id, org.id, client.client_id);

    entity = await createTestEntity({
      name: 'Test Brand',
      entity_type: 'brand',
      organization_id: org.id,
      domain: 'original.com',
    });

    ctx = {
      organizationId: org.id,
      userId: user.id,
      isAuthenticated: true,
      clientId: client.client_id,
    } as ToolContext;
  });

  it('should record a change event when metadata field is updated', async () => {
    const sql = getTestDb();

    const before =
      await sql`SELECT COUNT(*)::int as count FROM events WHERE ${entity.id} = ANY(entity_ids) AND semantic_type = 'change'`;
    const beforeCount = before[0].count;

    await manageEntity({ action: 'update', entity_id: entity.id, domain: 'updated.com' }, env, ctx);

    // Wait for fire-and-forget insert
    await new Promise((r) => setTimeout(r, 300));

    const after =
      await sql`SELECT COUNT(*)::int as count FROM events WHERE ${entity.id} = ANY(entity_ids) AND semantic_type = 'change'`;
    expect(after[0].count).toBe(beforeCount + 1);

    const events = await sql`
      SELECT payload_text, metadata, title, created_by
      FROM events
      WHERE ${entity.id} = ANY(entity_ids) AND semantic_type = 'change'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(events.length).toBe(1);

    const event = events[0];
    expect(event.created_by).toBe(user.id);
    expect(event.title).toContain('domain');

    const metadata =
      typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
    expect(metadata.changes).toBeDefined();

    const domainChange = metadata.changes.find((c: any) => c.field === 'domain');
    expect(domainChange).toBeDefined();
    expect(domainChange.old).toBe('original.com');
    expect(domainChange.new).toBe('updated.com');
  });

  it('should record a change event when name is updated', async () => {
    const sql = getTestDb();

    await manageEntity({ action: 'update', entity_id: entity.id, name: 'Renamed Brand' }, env, ctx);
    await new Promise((r) => setTimeout(r, 300));

    const events = await sql`
      SELECT metadata
      FROM events
      WHERE ${entity.id} = ANY(entity_ids) AND semantic_type = 'change'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const metadata =
      typeof events[0].metadata === 'string' ? JSON.parse(events[0].metadata) : events[0].metadata;

    const nameChange = metadata.changes.find((c: any) => c.field === 'name');
    expect(nameChange).toBeDefined();
    expect(nameChange.old).toBe('Test Brand');
    expect(nameChange.new).toBe('Renamed Brand');
  });

  it('should not record a change event when nothing actually changes', async () => {
    const sql = getTestDb();

    const before =
      await sql`SELECT COUNT(*)::int as count FROM events WHERE ${entity.id} = ANY(entity_ids) AND semantic_type = 'change'`;

    await manageEntity({ action: 'update', entity_id: entity.id, name: 'Renamed Brand' }, env, ctx);
    await new Promise((r) => setTimeout(r, 300));

    const after =
      await sql`SELECT COUNT(*)::int as count FROM events WHERE ${entity.id} = ANY(entity_ids) AND semantic_type = 'change'`;
    expect(after[0].count).toBe(before[0].count);
  });

  it('should record multiple field changes in a single event', async () => {
    const sql = getTestDb();

    await manageEntity(
      {
        action: 'update',
        entity_id: entity.id,
        name: 'Multi Change Brand',
        domain: 'multi.com',
        category: 'saas',
      },
      env,
      ctx
    );
    await new Promise((r) => setTimeout(r, 300));

    const events = await sql`
      SELECT metadata, title
      FROM events
      WHERE ${entity.id} = ANY(entity_ids) AND semantic_type = 'change'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const metadata =
      typeof events[0].metadata === 'string' ? JSON.parse(events[0].metadata) : events[0].metadata;

    expect(metadata.changes.length).toBeGreaterThanOrEqual(2);

    const fields = metadata.changes.map((c: any) => c.field);
    expect(fields).toContain('name');
    expect(fields).toContain('domain');
  });
});
