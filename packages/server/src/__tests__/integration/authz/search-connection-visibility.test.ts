import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { search } from '../../../tools/search';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

function ctxFor(
  orgId: string,
  userId: string | null,
  memberRole: 'owner' | 'admin' | 'member' | null = 'member'
): ToolContext {
  return {
    organizationId: orgId,
    userId,
    memberRole: userId ? memberRole : null,
    isAuthenticated: !!userId,
    tokenType: userId ? 'oauth' : 'anonymous',
    scopedToOrg: !userId,
    allowCrossOrg: !!userId,
    scopes: userId ? ['mcp:read'] : undefined,
  };
}

describe('search_memory connection visibility', () => {
  let orgId: string;
  let entityId: number;
  let privateOnlyEntityId: number;
  let ownerUserId: string;
  let adminUserId: string;
  let memberUserId: string;
  let orgConnectionId: number;
  let ownerPrivateConnectionId: number;
  let memberPrivateConnectionId: number;
  let legacyUnownedConnectionId: number;
  let deletedOrgConnectionId: number;
  let foreignOrgConnectionId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();

    const org = await createTestOrganization({ name: 'Search Conn Visibility Org' });
    orgId = org.id;
    await seedSystemEntityTypes();

    const owner = await createTestUser();
    const admin = await createTestUser();
    const member = await createTestUser();
    ownerUserId = owner.id;
    adminUserId = admin.id;
    memberUserId = member.id;
    await addUserToOrganization(ownerUserId, orgId, 'owner');
    await addUserToOrganization(adminUserId, orgId, 'admin');
    await addUserToOrganization(memberUserId, orgId, 'member');

    const entity = await createTestEntity({
      name: 'Visibility Probe Co',
      entity_type: 'company',
      organization_id: orgId,
      created_by: ownerUserId,
    });
    entityId = entity.id;
    privateOnlyEntityId = (
      await createTestEntity({
        name: 'Private Connection Only Co',
        entity_type: 'company',
        organization_id: orgId,
        created_by: ownerUserId,
      })
    ).id;

    const mk = async (opts: {
      display_name: string;
      created_by?: string;
      visibility: 'org' | 'private';
    }) =>
      (
        await createTestConnection({
          organization_id: orgId,
          connector_key: 'github',
          display_name: opts.display_name,
          entity_ids: [entityId],
          created_by: opts.created_by,
          visibility: opts.visibility,
        })
      ).id;

    orgConnectionId = await mk({
      display_name: 'Org Visible GitHub',
      created_by: ownerUserId,
      visibility: 'org',
    });
    ownerPrivateConnectionId = await mk({
      display_name: 'Owner Private GitHub',
      created_by: ownerUserId,
      visibility: 'private',
    });
    memberPrivateConnectionId = await mk({
      display_name: 'Member Private GitHub',
      created_by: memberUserId,
      visibility: 'private',
    });
    legacyUnownedConnectionId = await mk({
      display_name: 'Legacy Unowned GitHub',
      visibility: 'private',
    });
    deletedOrgConnectionId = await mk({
      display_name: 'Soft Deleted GitHub',
      created_by: ownerUserId,
      visibility: 'org',
    });
    await createTestConnection({
      organization_id: orgId,
      connector_key: 'github',
      display_name: 'Private Only GitHub',
      entity_ids: [privateOnlyEntityId],
      created_by: ownerUserId,
      visibility: 'private',
    });

    await getTestDb()`
      UPDATE connections SET deleted_at = NOW() WHERE id = ${deletedOrgConnectionId}
    `;

    const foreignOrg = await createTestOrganization({ name: 'Foreign Search Org' });
    foreignOrgConnectionId = (
      await createTestConnection({
        organization_id: foreignOrg.id,
        connector_key: 'github',
        display_name: 'Foreign Org GitHub',
        entity_ids: [entityId],
        visibility: 'org',
      })
    ).id;
  });

  async function connectionIdsFor(ctx: ToolContext): Promise<number[]> {
    const result = await search(
      { entity_id: entityId, include_content: false },
      {} as Parameters<typeof search>[1],
      ctx
    );
    return (result.connections ?? []).map((connection) => Number(connection.connection_id));
  }

  it('returns only org-visible and self-owned connections to a member', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, memberUserId, 'member'));

    expect(ids).toContain(orgConnectionId);
    expect(ids).toContain(memberPrivateConnectionId);
    expect(ids).not.toContain(ownerPrivateConnectionId);
    expect(ids).not.toContain(legacyUnownedConnectionId);
    expect(ids).not.toContain(foreignOrgConnectionId);
  });

  it('still returns the owner their own private connection', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, ownerUserId, 'owner'));

    expect(ids).toContain(ownerPrivateConnectionId);
    expect(ids).toContain(orgConnectionId);
    expect(ids).toContain(legacyUnownedConnectionId);
    expect(ids).not.toContain(memberPrivateConnectionId);
  });

  it('returns legacy-unowned but not user-owned private connections to an admin', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, adminUserId, 'admin'));

    expect(ids).toContain(orgConnectionId);
    expect(ids).toContain(legacyUnownedConnectionId);
    expect(ids).not.toContain(ownerPrivateConnectionId);
    expect(ids).not.toContain(memberPrivateConnectionId);
  });

  it('gives an anonymous caller org-visible connections only', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, null, null));

    expect(ids).toContain(orgConnectionId);
    expect(ids).not.toContain(ownerPrivateConnectionId);
    expect(ids).not.toContain(memberPrivateConnectionId);
    expect(ids).not.toContain(legacyUnownedConnectionId);
  });

  it('excludes soft-deleted connections', async () => {
    const ids = await connectionIdsFor(ctxFor(orgId, ownerUserId, 'owner'));

    expect(ids).not.toContain(deletedOrgConnectionId);
  });

  it('does not count hidden private connections in entity stats or suggestions', async () => {
    const result = await search(
      { entity_id: privateOnlyEntityId, include_content: false },
      {} as Parameters<typeof search>[1],
      ctxFor(orgId, memberUserId, 'member')
    );

    expect(result.connections).toEqual([]);
    expect(result.entity?.stats.connection_count).toBe(0);
    expect(result.entity?.stats.active_connection_count).toBe(0);
    expect(result.suggestion).toContain('no connections');
  });
});
