/**
 * Integration test: save_content's $member auth_user_id claim write heals its
 * pre-existing legacy wrong-source row.
 *
 * The authz channel-visibility gate resolves a user to their $member via an
 * entity_identities row with namespace `auth_user_id` AND
 * `source_connector='auth:signup'`. save_content used to write that claim with
 * `source_connector='save_content'`; because idx_entity_identities_live_unique_scoped
 * is on (org, namespace, identifier), the wrong-source row BLOCKED the correct
 * auth:signup insert forever — a permanent poison the member-claim-drift
 * detector reports but cannot repair. The fix writes `auth:signup` and heals
 * that legacy source on conflict without promoting other identity sources.
 *
 * DB-backed (save_content writes events + entity_identities), so it runs
 * against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { runMemberClaimDriftCheck } from '../../../scheduled/member-claim-drift';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > $member auth_user_id claim heals poison source', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let memberId: number;

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Member Claim Heal Org' });
    user = await createTestUser({ email: 'claim-heal@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    // The user's $member entity with an email identity, exactly as the
    // email-based resolution in save_content step 4 expects.
    const member = await createTestEntity({
      name: user.email,
      entity_type: '$member',
      organization_id: org.id,
    });
    memberId = member.id;
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_identities
        (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES
        (${org.id}, ${memberId}, 'email', ${user.email}, 'auth:signup')
    `;
    // The PRE-FIX poison state: save_content historically wrote this row with
    // the wrong source, which blocks the auth:signup insert on the unique
    // (org, namespace, identifier) index.
    await sql`
      INSERT INTO entity_identities
        (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES
        (${org.id}, ${memberId}, 'auth_user_id', ${user.id}, 'save_content')
      ON CONFLICT (organization_id, namespace, identifier, COALESCE(scope_connection_id, 0))
        WHERE deleted_at IS NULL
      DO NOTHING
    `;
  });

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
      sourceContext: null,
    } as ToolContext;
  }

  it('heals the poison auth_user_id claim to auth:signup and appends the member', async () => {
    const result = await saveContent(
      {
        content: 'A save from the owner should repair their member claim.',
        semantic_type: 'note',
        title: 'claim heal',
        metadata: {},
      } as never,
      {} as never,
      ctx()
    );

    expect(result.entity_ids).toContain(memberId);

    const sql = getTestDb();
    const rows = await sql<{ source_connector: string; entity_id: number }>`
      SELECT source_connector, entity_id
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'auth_user_id'
        AND identifier = ${user.id}
        AND deleted_at IS NULL
    `;
    // The poison row is gone (single claim, healed to auth:signup, pointing at
    // the $member entity) — no duplicate with the old source survives.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_connector).toBe('auth:signup');
    expect(rows[0]!.entity_id).toBe(memberId);

    // The drift detector sees a resolvable claim now.
    await expect(runMemberClaimDriftCheck()).resolves.toEqual({
      missingClaim: 0,
      poisonClaim: 0,
    });
  });

  it('does not promote a claim written by an untrusted source', async () => {
    const sql = getTestDb();
    await sql`
      UPDATE entity_identities
      SET source_connector = 'user:provided'
      WHERE organization_id = ${org.id}
        AND namespace = 'auth_user_id'
        AND identifier = ${user.id}
        AND deleted_at IS NULL
    `;

    await saveContent(
      {
        content: 'An untrusted identity claim must stay untrusted.',
        semantic_type: 'note',
        title: 'claim trust boundary',
        metadata: {},
      } as never,
      {} as never,
      ctx()
    );

    const rows = await sql<{ source_connector: string }>`
      SELECT source_connector
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'auth_user_id'
        AND identifier = ${user.id}
        AND deleted_at IS NULL
    `;
    expect(rows).toEqual([{ source_connector: 'user:provided' }]);
  });
});
