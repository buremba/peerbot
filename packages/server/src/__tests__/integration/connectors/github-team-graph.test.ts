/**
 * GitHub org-membership team graph contract (#17, PR2).
 *
 * On install/refresh the org's members build a team graph: the org becomes a
 * `company` entity, each member a `person`, joined by `member_of` edges. Asserts
 * the entity model (reuse `company` + `member_of`, no `team` type), idempotency,
 * person-collapse with an already-authored contributor, and that User-account
 * installs (no members) build nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEntityLinks,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { buildGithubTeamGraph } from '../../../gateway/routes/public/github-team-graph';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

async function ensureType(orgId: string, slug: string, name: string): Promise<void> {
  const sql = getTestDb();
  const existing = await sql`
    SELECT id FROM entity_types
    WHERE organization_id = ${orgId} AND slug = ${slug} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length === 0) {
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${orgId}, ${slug}, ${name}, current_timestamp, current_timestamp)
    `;
  }
}

async function seedOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureType(org.id, 'person', 'Person');
  await ensureType(org.id, 'company', 'Company');
  return org;
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

const orgAccount = { login: 'acme-co', id: 100, type: 'Organization' };

describe('github team graph', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('builds the org company, member persons, and member_of edges (idempotent on re-run)', async () => {
    const org = await seedOrg('Team Graph Org');

    const result = await buildGithubTeamGraph({
      organizationId: org.id,
      account: orgAccount,
      members: [
        { login: 'Alice', id: 1 },
        { login: 'Bob', id: 2 },
      ],
    });

    expect(result.companyEntityId).not.toBeNull();
    expect(result.memberEntityIds).toHaveLength(2);
    expect(result.createdEdges).toBe(2);

    // One company (the org), reusing the `company` type — no `team` type created.
    const companies = await entitiesOfType(org.id, 'company');
    expect(companies).toHaveLength(1);
    expect(companies[0].name).toBe('acme-co');
    const noTeamType = await getTestDb()`
      SELECT id FROM entity_types WHERE organization_id = ${org.id} AND slug = 'team'
    `;
    expect(noTeamType).toHaveLength(0);

    const people = await entitiesOfType(org.id, 'person');
    expect(people).toHaveLength(2);

    const edges = await memberOfEdges(org.id);
    expect(edges).toHaveLength(2);
    // Every edge points person -> company.
    for (const e of edges) {
      expect(e.to_entity_id).toBe(companies[0].id);
      expect(people.map((p) => p.id)).toContain(e.from_entity_id);
    }

    // Re-run with the same members + one new one: idempotent edges, +1 created.
    const rerun = await buildGithubTeamGraph({
      organizationId: org.id,
      account: orgAccount,
      members: [
        { login: 'Alice', id: 1 },
        { login: 'Bob', id: 2 },
        { login: 'Carol', id: 3 },
      ],
    });
    expect(rerun.createdEdges).toBe(1);
    expect(await entitiesOfType(org.id, 'company')).toHaveLength(1);
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(3);
    expect(await memberOfEdges(org.id)).toHaveLength(3);
  });

  it('collapses a member onto an already-authored contributor (one person, not two)', async () => {
    const org = await seedOrg('Collapse Org');
    // Octocat authored an issue first (poll path) — creates a person keyed on id.
    await createTestConnectorDefinition({
      key: 'github',
      name: 'GitHub',
      organization_id: org.id,
      feeds_schema: {
        issues: {
          eventKinds: {
            issue: {
              entityLinks: [
                {
                  entityType: 'person',
                  autoCreate: true,
                  titlePath: 'metadata.author_login',
                  identities: [
                    { namespace: 'github_user_id', eventPath: 'metadata.author_id' },
                    { namespace: 'github_login', eventPath: 'metadata.author_login' },
                  ],
                },
              ],
            },
          },
        },
      },
    });
    clearEntityLinkRulesCache();
    await applyEntityLinks({
      connectorKey: 'github',
      feedKey: 'issues',
      orgId: org.id,
      items: [{ origin_type: 'issue', metadata: { author_login: 'Octocat', author_id: '42' } }],
    });
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(1);

    // Now Octocat shows up in the org membership with the SAME id → must reuse
    // the existing person, not create a second one.
    const result = await buildGithubTeamGraph({
      organizationId: org.id,
      account: orgAccount,
      members: [{ login: 'Octocat', id: 42 }],
    });
    expect(result.memberEntityIds).toHaveLength(1);
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(1);
    const edges = await memberOfEdges(org.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_entity_id).toBe(result.memberEntityIds[0]);
  });

  it('builds nothing for a User-account install (no org members)', async () => {
    const org = await seedOrg('User Install Org');
    const result = await buildGithubTeamGraph({
      organizationId: org.id,
      account: { login: 'solo-dev', id: 7, type: 'User' },
      members: [{ login: 'solo-dev', id: 7 }],
    });
    expect(result.companyEntityId).toBeNull();
    expect(result.memberEntityIds).toHaveLength(0);
    expect(await entitiesOfType(org.id, 'company')).toHaveLength(0);
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(0);
  });

  it('tenant-scoped: the same member in two orgs builds two distinct persons + companies', async () => {
    const orgA = await seedOrg('Tenant A');
    const orgB = await seedOrg('Tenant B');

    await buildGithubTeamGraph({
      organizationId: orgA.id,
      account: orgAccount,
      members: [{ login: 'Shared', id: 999 }],
    });
    await buildGithubTeamGraph({
      organizationId: orgB.id,
      account: orgAccount,
      members: [{ login: 'Shared', id: 999 }],
    });

    const peopleA = await entitiesOfType(orgA.id, 'person');
    const peopleB = await entitiesOfType(orgB.id, 'person');
    expect(peopleA).toHaveLength(1);
    expect(peopleB).toHaveLength(1);
    expect(peopleA[0].id).not.toBe(peopleB[0].id);

    expect(await memberOfEdges(orgA.id)).toHaveLength(1);
    expect(await memberOfEdges(orgB.id)).toHaveLength(1);
  });
});
