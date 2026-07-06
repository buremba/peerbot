/**
 * GitHub repo-membership graph contract — proves the generic `buildAccessGraph`
 * engine generalizes to a SECOND source. Repos become `repo` entities keyed on
 * `github_repo_full_name`, collaborators become persons joined by `member_of`
 * edges, a collaborator who already exists (carrying a `github_user_id` claim)
 * COLLAPSES onto that entity (the identity-first fix the original org-level
 * GitHub builder lacked), departures reconcile, and the build stamps
 * `authz_source_acl_state`.
 */

import { normalizeGithubRepoFullName } from '@lobu/connectors/github-identity';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildGithubRepoGraph } from '../../../authz/github-repo-graph';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const CONN = 'conn-gh';

async function ensureType(orgId: string, slug: string, name: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${orgId}, ${slug}, ${name}, current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
  `;
}

async function seedOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  // The engine auto-creates `person` entities for collaborators; the type must
  // exist in the org (prod seeds default types at org creation).
  await ensureType(org.id, 'person', 'Person');
  return { org, user };
}

async function entitiesOfType(orgId: string, slug: string) {
  const sql = getTestDb();
  return sql<{ id: number; name: string }[]>`
    SELECT e.id, e.name
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${orgId} AND et.slug = ${slug} AND e.deleted_at IS NULL
    ORDER BY e.id
  `;
}

async function memberOfEdges(orgId: string) {
  const sql = getTestDb();
  return sql<{ from_entity_id: number; to_entity_id: number }[]>`
    SELECT r.from_entity_id, r.to_entity_id
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.organization_id = ${orgId}
      AND rt.slug = 'member_of'
      AND r.deleted_at IS NULL
    ORDER BY r.from_entity_id
  `;
}

describe('github repo graph', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('builds repo entities + member_of edges and marks the connection enforced', async () => {
    const { org } = await seedOrg('GitHub Graph Org');

    const result = await buildGithubRepoGraph({
      organizationId: org.id,
      connectionId: CONN,
      repos: [
        {
          fullName: 'lobu-ai/lobu',
          collaborators: [
            { login: 'alice', id: 101 },
            { login: 'bob', id: 102 },
          ],
        },
        { fullName: 'lobu-ai/secret', collaborators: [{ login: 'bob', id: 102 }] },
      ],
    });

    // Repo entities are keyed on the normalized (lowercased) full name.
    expect(Object.keys(result.resourceEntityIds).sort()).toEqual([
      normalizeGithubRepoFullName('lobu-ai/lobu'),
      normalizeGithubRepoFullName('lobu-ai/secret'),
    ]);
    // 3 edges: (alice,lobu), (bob,lobu), (bob,secret).
    expect(result.createdEdges).toBe(3);

    expect(await entitiesOfType(org.id, 'repo')).toHaveLength(2);
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(2); // alice + bob

    const sql = getTestDb();
    const stateRows = await sql`
      SELECT acl_support, freshness_state FROM authz_source_acl_state
      WHERE organization_id = ${org.id} AND connection_id = ${CONN}
    `;
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0].acl_support).toBe('full');
    expect(stateRows[0].freshness_state).toBe('fresh');
  });

  it('collapses a collaborator onto an existing entity carrying github_user_id (no second person)', async () => {
    const { org, user } = await seedOrg('Collapse Org');
    // A $member who already has a github_user_id claim (e.g. signed in + linked).
    const entity = await createTestEntity({
      name: 'Alice',
      entity_type: '$member',
      organization_id: org.id,
      created_by: user.id,
    });
    const sql = getTestDb();
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${entity.id}, 'github_user_id', '101', 'connector:github')
    `;
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(0);

    const result = await buildGithubRepoGraph({
      organizationId: org.id,
      connectionId: CONN,
      repos: [{ fullName: 'lobu-ai/lobu', collaborators: [{ login: 'alice', id: 101 }] }],
    });

    // Alice resolved to her existing $member — NOT a new person.
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(0);
    expect(result.memberEntityIds).toEqual([entity.id]);
    const edges = await memberOfEdges(org.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_entity_id).toBe(entity.id);
  });

  it('reconciles departures: a collaborator removed on re-sync loses their edge', async () => {
    const { org } = await seedOrg('Reconcile Org');
    await buildGithubRepoGraph({
      organizationId: org.id,
      connectionId: CONN,
      repos: [
        {
          fullName: 'lobu-ai/lobu',
          collaborators: [
            { login: 'alice', id: 101 },
            { login: 'bob', id: 102 },
          ],
        },
      ],
    });
    expect(await memberOfEdges(org.id)).toHaveLength(2);

    // Bob is removed from the repo → re-sync with just Alice.
    const result = await buildGithubRepoGraph({
      organizationId: org.id,
      connectionId: CONN,
      repos: [{ fullName: 'lobu-ai/lobu', collaborators: [{ login: 'alice', id: 101 }] }],
    });
    expect(result.removedEdges).toBe(1);
    const edges = await memberOfEdges(org.id);
    expect(edges).toHaveLength(1);
  });
});
