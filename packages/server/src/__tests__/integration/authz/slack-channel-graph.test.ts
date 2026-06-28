/**
 * Slack channel-membership graph contract (authz program, Slack vertical).
 *
 * Mirrors the GitHub team-graph contract: channels become `channel` entities,
 * members become persons joined by `member_of` edges, and a member who already
 * signed in (their `$member` carries a `slack_user_id` claim) COLLAPSES onto
 * that one entity instead of forking a second person. Also asserts idempotency,
 * tenant scoping, and that the build stamps `authz_source_acl_state` so the gate
 * starts enforcing the connection.
 */

import { normalizeSlackUserId } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSlackChannelGraph, slackChannelKey } from '../../../authz/slack-channel-graph';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEAM = 'T01ENG';

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
  // The Slack builder auto-creates `person` entities for members; the type must
  // exist in the org (prod seeds default types at org creation). Mirror the
  // GitHub team-graph test.
  await ensureType(org.id, 'person', 'Person');
  return { org, user };
}

/** Seed a `$member` entity carrying both an auth_user_id and a (combined)
 * slack_user_id claim — i.e. a user who signed in AND linked Slack. */
async function seedSignedInMember(opts: {
  orgId: string;
  userId: string;
  name: string;
  slackUserId: string;
}): Promise<number> {
  const sql = getTestDb();
  const entity = await createTestEntity({
    name: opts.name,
    entity_type: '$member',
    organization_id: opts.orgId,
    created_by: opts.userId,
  });
  const combined = normalizeSlackUserId(TEAM, opts.slackUserId);
  await sql`
    INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
    VALUES
      (${opts.orgId}, ${entity.id}, 'auth_user_id', ${opts.userId}, 'auth:signup'),
      (${opts.orgId}, ${entity.id}, 'slack_user_id', ${combined}, 'connector:slack')
  `;
  return entity.id;
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

describe('slack channel graph', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('builds channel entities + member_of edges and marks the connection enforced', async () => {
    const { org } = await seedOrg('Slack Graph Org');

    const result = await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: 'conn-acme',
      teamId: TEAM,
      channels: [
        {
          channelId: 'C01ENG',
          name: 'eng',
          memberSlackUserIds: ['U01ALICE', 'U01BOB'],
        },
        {
          channelId: 'C01SEC',
          name: 'secret',
          isPrivate: true,
          memberSlackUserIds: ['U01BOB'],
        },
      ],
    });

    expect(Object.keys(result.channelEntityIds)).toEqual(['C01ENG', 'C01SEC']);
    // 3 edges: (alice,eng), (bob,eng), (bob,secret).
    expect(result.createdEdges).toBe(3);

    const channels = await entitiesOfType(org.id, 'channel');
    expect(channels).toHaveLength(2);
    const people = await entitiesOfType(org.id, 'person');
    expect(people).toHaveLength(2); // alice + bob (neither signed in here)

    // The connection is now ACL-enforced.
    const sql = getTestDb();
    const stateRows = await sql`
      SELECT acl_support, freshness_state FROM authz_source_acl_state
      WHERE organization_id = ${org.id} AND connection_id = 'conn-acme'
    `;
    expect(stateRows).toHaveLength(1);
    expect(stateRows[0].acl_support).toBe('full');
    expect(stateRows[0].freshness_state).toBe('fresh');
  });

  it('collapses a member onto an already-signed-in $member (no second person)', async () => {
    const { org, user } = await seedOrg('Collapse Org');
    const memberEntityId = await seedSignedInMember({
      orgId: org.id,
      userId: user.id,
      name: 'Alice',
      slackUserId: 'U01ALICE',
    });
    // Before the build there are no persons — only the $member.
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(0);

    const result = await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: 'conn-acme',
      teamId: TEAM,
      channels: [{ channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] }],
    });

    // Alice resolved to her existing $member — NOT a new person.
    expect(await entitiesOfType(org.id, 'person')).toHaveLength(0);
    expect(result.memberEntityIds).toEqual([memberEntityId]);
    const edges = await memberOfEdges(org.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_entity_id).toBe(memberEntityId);
  });

  it('is idempotent on re-run (edges + entities deduped, new member adds one edge)', async () => {
    const { org } = await seedOrg('Idempotent Org');
    const base = {
      organizationId: org.id,
      connectionId: 'conn-acme',
      teamId: TEAM,
    };
    const first = await buildSlackChannelGraph({
      ...base,
      channels: [{ channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] }],
    });
    expect(first.createdEdges).toBe(1);

    const second = await buildSlackChannelGraph({
      ...base,
      channels: [
        {
          channelId: 'C01ENG',
          name: 'eng',
          memberSlackUserIds: ['U01ALICE', 'U01BOB'],
        },
      ],
    });
    expect(second.createdEdges).toBe(1); // only bob is new
    expect(await entitiesOfType(org.id, 'channel')).toHaveLength(1);
    expect(await memberOfEdges(org.id)).toHaveLength(2);
  });

  it('revokes a departed member — re-sync without Alice soft-deletes her edge', async () => {
    const { org } = await seedOrg('Revoke Org');
    const base = { organizationId: org.id, connectionId: 'conn-acme', teamId: TEAM };

    await buildSlackChannelGraph({
      ...base,
      channels: [
        { channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE', 'U01BOB'] },
      ],
    });
    expect(await memberOfEdges(org.id)).toHaveLength(2);

    // Alice left #eng — re-sync reflects the source's current membership.
    const rerun = await buildSlackChannelGraph({
      ...base,
      channels: [{ channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01BOB'] }],
    });
    expect(rerun.removedEdges).toBe(1);
    expect(rerun.createdEdges).toBe(0);
    expect(await memberOfEdges(org.id)).toHaveLength(1); // only Bob remains
  });

  it('tenant-scopes channels by team — the same channel id in two orgs is two entities', async () => {
    const a = await seedOrg('Tenant A');
    const b = await seedOrg('Tenant B');
    for (const org of [a.org, b.org]) {
      await buildSlackChannelGraph({
        organizationId: org.id,
        connectionId: 'conn-x',
        teamId: TEAM,
        channels: [
          {
            channelId: 'C01ENG',
            name: 'eng',
            memberSlackUserIds: ['U01ALICE'],
          },
        ],
      });
    }
    const chA = await entitiesOfType(a.org.id, 'channel');
    const chB = await entitiesOfType(b.org.id, 'channel');
    expect(chA).toHaveLength(1);
    expect(chB).toHaveLength(1);
    expect(chA[0].id).not.toBe(chB[0].id);
  });

  it('builds nothing without a team id or channels', async () => {
    const { org } = await seedOrg('Empty Org');
    const noTeam = await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: 'c',
      teamId: '',
      channels: [{ channelId: 'C01ENG', memberSlackUserIds: ['U01ALICE'] }],
    });
    expect(noTeam.createdEdges).toBe(0);
    expect(Object.keys(noTeam.channelEntityIds)).toHaveLength(0);

    const noChannels = await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: 'c',
      teamId: TEAM,
      channels: [],
    });
    expect(noChannels.createdEdges).toBe(0);
  });

  it('exposes a stable team-scoped channel key', () => {
    expect(slackChannelKey('T01eng', 'c01eng')).toBe('T01ENG:C01ENG');
  });
});
