/**
 * Regression: creating an invitee placeholder $member must NOT stamp any
 * inviter's `auth_user_id` claim onto the invitee's entity.
 *
 * The `afterCreateInvitation` auth hook creates a placeholder $member for the
 * invited email while the invite is pending. It previously passed the inviter's
 * user id as `userId`, and `ensureMemberEntity` writes `auth_user_id = userId`
 * (source `auth:signup`) onto the entity it resolves BY EMAIL — i.e. the
 * invitee's. The authz channel-visibility gate resolves a logged-in user to
 * their $member via exactly that claim, so the inviter would resolve to the
 * invitee's entity and inherit the invitee's channel visibility.
 *
 * A pending invitee has no signed-in identity yet; their placeholder must carry
 * NO `auth_user_id` claim. It is minted for real when they accept and sign in.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureMemberEntity } from '../member-entity';
import { ensureMemberEntityType } from '../member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import { createTestOrganization, createTestUser } from '../../__tests__/setup/test-fixtures';

describe('ensureMemberEntity — invite placeholder does not adopt the inviter identity', () => {
  let orgId: string;
  let inviterUserId: string;
  const inviteeEmail = 'pending-invitee@test.example.com';

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({
      name: 'Invite Claim Org',
      slug: 'invite-claim-org',
      visibility: 'private',
    });
    orgId = org.id;
    const inviter = await createTestUser({ email: 'inviter@test.example.com' });
    inviterUserId = inviter.id;
    await ensureMemberEntityType(orgId);
  });

  it('creates the invitee placeholder with NO auth_user_id claim (the fixed hook shape)', async () => {
    // The corrected afterCreateInvitation call: resolve/create the placeholder
    // $member BY the invitee's email, attributing authorship to the inviter but
    // asserting NO identity for the invitee. The invitee's real auth_user_id is
    // minted only when they accept and sign in.
    await ensureMemberEntity({
      organizationId: orgId,
      createdByUserId: inviterUserId,
      name: inviteeEmail,
      email: inviteeEmail,
      role: 'member',
      status: 'invited',
    });

    const sql = getTestDb();

    // The invitee placeholder exists, authored by the inviter…
    const inviteeRows = await sql<{ id: number; created_by: string | null }>`
      SELECT e.id, e.created_by
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id AND et.organization_id = e.organization_id
      WHERE et.slug = '$member'
        AND e.organization_id = ${orgId}
        AND e.metadata->>'email' = ${inviteeEmail}
        AND e.deleted_at IS NULL
    `;
    expect(inviteeRows).toHaveLength(1);
    const inviteeEntityId = Number(inviteeRows[0].id);
    // Authorship is preserved — created_by is the inviter, not "system".
    expect(inviteeRows[0].created_by).toBe(inviterUserId);

    // …and it carries NO auth_user_id claim at all.
    const claims = await sql<{ identifier: string }>`
      SELECT identifier
      FROM entity_identities
      WHERE organization_id = ${orgId}
        AND entity_id = ${inviteeEntityId}
        AND namespace = 'auth_user_id'
        AND deleted_at IS NULL
    `;
    expect(claims).toHaveLength(0);

    // …and specifically the inviter's claim did not leak into this org.
    const inviterClaim = await sql<{ entity_id: number }>`
      SELECT entity_id
      FROM entity_identities
      WHERE organization_id = ${orgId}
        AND namespace = 'auth_user_id'
        AND identifier = ${inviterUserId}
        AND deleted_at IS NULL
    `;
    expect(inviterClaim).toHaveLength(0);
  });
});
