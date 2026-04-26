import { beforeAll, describe, expect, it } from 'vitest';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestOrganization,
  createTestSession,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('$member visibility policy on public orgs', () => {
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let memberUser: Awaited<ReturnType<typeof createTestUser>>;
  let adminCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;

  const ADMIN_EMAIL = 'admin-redaction@test.example.com';
  const MEMBER_EMAIL = 'plain-member@test.example.com';

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    publicOrg = await createTestOrganization({
      name: 'Member Redaction Public Org',
      slug: 'member-redaction-public',
      visibility: 'public',
    });

    adminUser = await createTestUser({ email: ADMIN_EMAIL });
    memberUser = await createTestUser({ email: MEMBER_EMAIL });
    adminCookie = (await createTestSession(adminUser.id)).cookieHeader;
    memberCookie = (await createTestSession(memberUser.id)).cookieHeader;

    await ensureMemberEntityType(publicOrg.id);

    const sql = getTestDb();
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES
        (gen_random_uuid()::text, ${publicOrg.id}, ${adminUser.id}, 'owner', NOW()),
        (gen_random_uuid()::text, ${publicOrg.id}, ${memberUser.id}, 'member', NOW())
      ON CONFLICT DO NOTHING
    `;

    await sql`
      INSERT INTO entities (
        name, slug, entity_type_id, organization_id, metadata, created_by, created_at, updated_at
      ) VALUES (
        'Plain Member',
        'plain-member',
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${publicOrg.id} AND deleted_at IS NULL),
        ${publicOrg.id},
        ${sql.json({ email: MEMBER_EMAIL, status: 'active', role: 'member' })},
        ${adminUser.id},
        NOW(), NOW()
      )
    `;

    const outsider = await createTestUser({ email: 'nonmember-nomercy@test.example.com' });
    outsiderCookie = (await createTestSession(outsider.id)).cookieHeader;
  });

  async function listMembers(cookie?: string) {
    return post(`/api/${publicOrg.slug}/manage_entity`, {
      body: { action: 'list', entity_type: '$member', limit: 50, offset: 0 },
      cookie,
    });
  }

  it('refuses the member list to anonymous callers', async () => {
    const response = await listMembers();
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(String(body.error)).toMatch(/only visible to members/i);
  });

  it('refuses the member list to authenticated non-members', async () => {
    const response = await listMembers(outsiderCookie);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(String(body.error)).toMatch(/only visible to members/i);
  });

  it('returns members without email to regular members', async () => {
    const response = await listMembers(memberCookie);
    expect(response.status).toBe(200);
    const body = await response.json();
    const hit = body.entities.find((e: any) => e.name === 'Plain Member');
    expect(hit).toBeTruthy();
    expect(hit.metadata).not.toHaveProperty('email');
    // Non-PII fields stay visible so the list view still renders useful columns.
    expect(hit.metadata.status).toBe('active');
  });

  it('returns member emails to admin/owner callers', async () => {
    const response = await listMembers(adminCookie);
    expect(response.status).toBe(200);
    const body = await response.json();
    const hit = body.entities.find((e: any) => e.name === 'Plain Member');
    expect(hit).toBeTruthy();
    expect(hit.metadata.email).toBe(MEMBER_EMAIL);
  });
});
