/**
 * Public $member privacy boundary.
 *
 * High-value coverage retained from the deleted redaction suite: public
 * workspaces can expose member rows to members, but regular members must not
 * see email metadata and outsiders/anonymous callers must not enumerate them.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization, createTestSession, createTestUser } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const MEMBER_EMAIL = 'plain-member@test.example.com';

describe('$member privacy contract', () => {
  let orgSlug: string;
  let ownerCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;

  beforeAll(async () => {
    await cleanupTestDatabase();

    const org = await createTestOrganization({
      name: 'Member Privacy Public Org',
      slug: 'member-privacy-public',
      visibility: 'public',
    });
    orgSlug = org.slug;

    const owner = await createTestUser({ email: 'member-privacy-owner@test.example.com' });
    const member = await createTestUser({ email: MEMBER_EMAIL });
    const outsider = await createTestUser({ email: 'member-privacy-outsider@test.example.com' });

    ownerCookie = (await createTestSession(owner.id)).cookieHeader;
    memberCookie = (await createTestSession(member.id)).cookieHeader;
    outsiderCookie = (await createTestSession(outsider.id)).cookieHeader;

    await ensureMemberEntityType(org.id);

    const sql = getTestDb();
    await sql`
      INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
      VALUES
        (gen_random_uuid()::text, ${org.id}, ${owner.id}, 'owner', NOW()),
        (gen_random_uuid()::text, ${org.id}, ${member.id}, 'member', NOW())
      ON CONFLICT DO NOTHING
    `;

    await sql`
      INSERT INTO entities (
        name, slug, entity_type_id, organization_id, metadata, created_by, created_at, updated_at
      ) VALUES (
        'Plain Member',
        'plain-member',
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        ${org.id},
        ${sql.json({ email: MEMBER_EMAIL, status: 'active', role: 'member' })},
        ${owner.id},
        NOW(), NOW()
      )
    `;
  });

  async function listMembers(cookie?: string) {
    return post(`/api/${orgSlug}/manage_entity`, {
      body: { action: 'list', entity_type: '$member', limit: 50, offset: 0 },
      cookie,
    });
  }

  it('does not allow anonymous or signed-in outsiders to enumerate members', async () => {
    for (const cookie of [undefined, outsiderCookie]) {
      const response = await listMembers(cookie);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(String(body.error)).toMatch(/only visible to members/i);
    }
  });

  it('redacts member emails for regular members but not owners/admins', async () => {
    const memberResponse = await listMembers(memberCookie);
    expect(memberResponse.status).toBe(200);
    const memberBody = await memberResponse.json();
    const memberHit = memberBody.entities.find((e: any) => e.name === 'Plain Member');
    expect(memberHit.metadata).not.toHaveProperty('email');
    expect(memberHit.metadata.status).toBe('active');

    const ownerResponse = await listMembers(ownerCookie);
    expect(ownerResponse.status).toBe(200);
    const ownerBody = await ownerResponse.json();
    const ownerHit = ownerBody.entities.find((e: any) => e.name === 'Plain Member');
    expect(ownerHit.metadata.email).toBe(MEMBER_EMAIL);
  });
});
