/**
 * `search_memory` connection visibility — INTRA-ORG authz gate.
 *
 * `fetchConnectionsForEntity` (tools/search.ts) enumerates the connections
 * attached to the primary entity and returns them under `connections`. Its
 * only filter used to be `connectionLinkedToBusinessEntitySql` — a PURE
 * business-entity linkage test with no `visibility`, no `created_by`, and no
 * `deleted_at` clause. `search_memory` sits in the most permissive tool tier
 * (PUBLIC_READ_ACTIONS: null) and `include_connections` defaults to TRUE, so
 * ANY plain org member could enumerate ANOTHER member's PRIVATE connections
 * just by searching an entity those connections are linked to.
 *
 * Every sibling read seam (manage_feeds read_feed, manage_connections
 * list/get, query_sql, connector pushdown) compiles the SAME predicate from
 * `authz/connection-visibility#compileConnectionRowVisibility`; this seam had
 * diverged. These tests assert on connection IDENTITY (connection_id /
 * display_name) — deliberately NOT on any secret value inside `config`, so a
 * redaction change elsewhere can never make them pass while the authz hole
 * stays open.
 */

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
  } as ToolContext;
}

describe('search_memory connection visibility (intra-org)', () => {
  let orgId: string;
  let entityId: number;
  let ownerUserId: string;
  let adminUserId: string;
  let memberUserId: string;
  let orgConnectionId: number;
  let ownerPrivateConnectionId: number;
  let memberPrivateConnectionId: number;
  let legacyUnownedConnectionId: number;
  let deletedOrgConnectionId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await initWorkspaceProvider();

    const org = await createTestOrganization({ name: 'Search Conn Visibility Org' });
    orgId = org.id;
    await seedSystemEntityTypes(orgId);

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

    // Every connection is linked to the SAME entity (via its default feed's
    // entity_ids), so linkage is never what distinguishes them — visibility is.
    const mk = async (opts: {
      display_name: string;
      created_by: string | undefined;
      visibility: 'org' | 'private';
    }) =>
      Number(
        (
          await createTestConnection({
            organization_id: orgId,
            connector_key: 'github',
            display_name: opts.display_name,
            entity_ids: [entityId],
            created_by: opts.created_by,
            visibility: opts.visibility,
          })
        ).id
      );

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
    // Legacy row predating `created_by`: admins may see it, plain members not.
    legacyUnownedConnectionId = await mk({
      display_name: 'Legacy Unowned GitHub',
      created_by: undefined,
      visibility: 'private',
    });
    deletedOrgConnectionId = await mk({
      display_name: 'Soft Deleted GitHub',
      created_by: ownerUserId,
      visibility: 'org',
    });

    await getTestDb()`
      UPDATE connections SET deleted_at = NOW() WHERE id = ${deletedOrgConnectionId}
    `;
  });

  async function connectionsFor(ctx: ToolContext): Promise<{
    ids: Set<number>;
    names: string[];
  }> {
    const result = await search(
      { entity_id: entityId, include_connections: true, include_content: false } as never,
      {} as never,
      ctx
    );
    const rows = result.connections ?? [];
    return {
      ids: new Set(rows.map((c) => Number(c.connection_id))),
      names: rows.map((c) => c.display_name ?? ''),
    };
  }

  it('does NOT leak another member\'s private connection to a plain org member', async () => {
    const { ids, names } = await connectionsFor(ctxFor(orgId, memberUserId, 'member'));

    // THE BUG: the owner's private connection is another user's private asset.
    expect(ids.has(ownerPrivateConnectionId)).toBe(false);
    expect(names).not.toContain('Owner Private GitHub');
    // Legacy-unowned private rows are admin-tier only.
    expect(ids.has(legacyUnownedConnectionId)).toBe(false);
    expect(names).not.toContain('Legacy Unowned GitHub');
  });

  it('still returns org-visible and own-private connections to that member', async () => {
    const { ids } = await connectionsFor(ctxFor(orgId, memberUserId, 'member'));

    expect(ids.has(orgConnectionId)).toBe(true);
    expect(ids.has(memberPrivateConnectionId)).toBe(true);
  });

  it('still returns the owner their own private connection', async () => {
    const { ids } = await connectionsFor(ctxFor(orgId, ownerUserId, 'owner'));

    expect(ids.has(ownerPrivateConnectionId)).toBe(true);
    expect(ids.has(orgConnectionId)).toBe(true);
    // Admin tier sees legacy-unowned rows...
    expect(ids.has(legacyUnownedConnectionId)).toBe(true);
    // ...but admin is NOT a bypass for another member's private connection.
    expect(ids.has(memberPrivateConnectionId)).toBe(false);
  });

  it('grants an admin the same tier as the owner', async () => {
    const { ids } = await connectionsFor(ctxFor(orgId, adminUserId, 'admin'));

    expect(ids.has(orgConnectionId)).toBe(true);
    expect(ids.has(legacyUnownedConnectionId)).toBe(true);
    expect(ids.has(ownerPrivateConnectionId)).toBe(false);
    expect(ids.has(memberPrivateConnectionId)).toBe(false);
  });

  it('gives an anonymous caller org-visible connections only', async () => {
    const { ids } = await connectionsFor(ctxFor(orgId, null, null));

    expect(ids.has(orgConnectionId)).toBe(true);
    expect(ids.has(ownerPrivateConnectionId)).toBe(false);
    expect(ids.has(memberPrivateConnectionId)).toBe(false);
    expect(ids.has(legacyUnownedConnectionId)).toBe(false);
  });

  it('excludes soft-deleted connections', async () => {
    const { ids } = await connectionsFor(ctxFor(orgId, ownerUserId, 'owner'));

    expect(ids.has(deletedOrgConnectionId)).toBe(false);
  });
});
