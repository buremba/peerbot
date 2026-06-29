/**
 * Channel audience read — the INVERSE of the visibility gate. Proves the
 * governance view ("who can recall #channel") reads the SAME `member_of` graph
 * the gate enforces: a member shows up in a channel's audience iff they'd be
 * allowed to recall it. Also proves the enforcement-status projection (enforced
 * vs not-graphed) and the requester "you" highlight.
 */

import { normalizeSlackUserId } from '@lobu/connector-sdk';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getChannelAudiences } from '../../../authz/audience';
import { syncSlackConnectionAcl } from '../../../authz/slack-acl-sync';
import { buildSlackChannelGraph } from '../../../authz/slack-channel-graph';
import { resolveBoundChannelRows } from '../../../gateway/channels/bound-channels';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEAM = 'T01ACME';
const CONN = 'conn-acme';

async function seedSignedInMember(opts: {
  orgId: string;
  userId: string;
  name: string;
  slackUserId: string;
}): Promise<void> {
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
}

async function setupWorkspace() {
  const org = await createTestOrganization({ name: 'Acme' });
  const alice = await createTestUser({ name: 'Alice' });
  await addUserToOrganization(alice.id, org.id, 'owner');
  const agent = await createTestAgent({ organizationId: org.id });

  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
  `;
  await sql`
    INSERT INTO agent_connections (id, agent_id, platform, organization_id, status)
    VALUES (${CONN}, ${agent.agentId}, 'slack', ${org.id}, 'active')
  `;
  for (const channelId of ['C01ENG', 'C01SEC']) {
    await sql`
      INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id)
      VALUES (${org.id}, ${agent.agentId}, 'slack', ${channelId}, ${TEAM})
    `;
  }
  await seedSignedInMember({
    orgId: org.id,
    userId: alice.id,
    name: 'Alice',
    slackUserId: 'U01ALICE',
  });
  return { org, alice, agent };
}

describe('channel audience read', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('returns each channel`s members from the same member_of graph the gate reads', async () => {
    const { org, alice, agent } = await setupWorkspace();
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [
        { channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] },
        { channelId: 'C01SEC', name: 'secret', isPrivate: true, memberSlackUserIds: ['U01BOB'] },
      ],
    });

    const sql = getTestDb();
    const rows = await resolveBoundChannelRows(sql, {
      organizationId: org.id,
      agentId: agent.agentId,
    });
    const audiences = await getChannelAudiences(sql, {
      organizationId: org.id,
      userId: alice.id,
      rows,
    });

    const eng = audiences.find((a) => a.channelId === 'C01ENG');
    const sec = audiences.find((a) => a.channelId === 'C01SEC');
    expect(eng).toBeTruthy();
    expect(sec).toBeTruthy();

    // #eng: Alice only, enforced, and SHE is the requester → "you".
    expect(eng?.enforcement.status).toBe('enforced');
    expect(eng?.memberCount).toBe(1);
    const aliceMember = eng?.members.find((m) => m.isYou);
    expect(aliceMember).toBeTruthy();
    expect(aliceMember?.source).toBe('you');
    expect(aliceMember?.displayName).toBe('Alice');

    // #secret: Bob (never signed in) → a plain Slack member, not the requester.
    expect(sec?.memberCount).toBe(1);
    expect(sec?.members.every((m) => !m.isYou)).toBe(true);
    expect(sec?.members[0]?.source).toBe('slack-member');
  });

  it('reports not-graphed (no audience) for a connection without a materialized graph', async () => {
    const { org, alice, agent } = await setupWorkspace();
    // No buildSlackChannelGraph → no authz_source_acl_state row.
    const sql = getTestDb();
    const rows = await resolveBoundChannelRows(sql, {
      organizationId: org.id,
      agentId: agent.agentId,
    });
    const audiences = await getChannelAudiences(sql, {
      organizationId: org.id,
      userId: alice.id,
      rows,
    });

    expect(audiences).toHaveLength(2);
    for (const a of audiences) {
      expect(a.enforcement.status).toBe('not-graphed');
      expect(a.memberCount).toBe(0);
      expect(a.members).toHaveLength(0);
    }
  });

  it('excludes the Lobu bot from a channel audience even though it is a Slack member', async () => {
    const { org, alice, agent } = await setupWorkspace();
    const sql = getTestDb();
    // The adapter backfills the bot's own Slack user id onto the connection.
    await sql`
      UPDATE agent_connections SET metadata = '{"botUserId":"UBOTLOBU"}'::jsonb
      WHERE id = ${CONN}
    `;

    // Production sync path: conversations.members returns Alice AND the bot.
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async () => ['U01ALICE', 'UBOTLOBU'],
          conversationInfo: async () => ({ name: 'eng', isPrivate: false }),
        },
        resolveBotToken: async () => 'xoxb-test-token',
      },
      { connectionId: CONN, organizationId: org.id },
    );
    expect(result.ok).toBe(true);

    const rows = await resolveBoundChannelRows(sql, {
      organizationId: org.id,
      agentId: agent.agentId,
    });
    const audiences = await getChannelAudiences(sql, {
      organizationId: org.id,
      userId: alice.id,
      rows,
    });
    const eng = audiences.find((a) => a.channelId === 'C01ENG');
    // Only Alice — the bot must neither appear nor count.
    expect(eng?.memberCount).toBe(1);
    const botCombined = normalizeSlackUserId(TEAM, 'UBOTLOBU');
    expect(eng?.members.some((m) => m.slackUserId === botCombined)).toBe(false);
    expect(eng?.members[0]?.isYou).toBe(true);
    // conversations.info name is captured and surfaced on the audience.
    expect(eng?.channelName).toBe('eng');
  });

  it('reports no current audience for a stale (aged-out) connection even with old member_of edges', async () => {
    const { org, alice, agent } = await setupWorkspace();
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [{ channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] }],
    });
    const sql = getTestDb();
    // The sync stops: age the graph past the freshness window. The gate fails
    // CLOSED, so the audience must too — old member_of edges still exist but
    // nobody can currently recall.
    await sql`
      UPDATE authz_source_acl_state
      SET last_synced_at = current_timestamp - interval '90 minutes'
      WHERE organization_id = ${org.id} AND connection_id = ${CONN}
    `;
    const rows = await resolveBoundChannelRows(sql, {
      organizationId: org.id,
      agentId: agent.agentId,
    });
    const audiences = await getChannelAudiences(sql, {
      organizationId: org.id,
      userId: alice.id,
      rows,
    });
    const eng = audiences.find((a) => a.channelId === 'C01ENG');
    expect(eng?.enforcement.status).toBe('stale');
    expect(eng?.memberCount).toBe(0);
    expect(eng?.members).toHaveLength(0);
  });

  it('marks a signed-in non-requester member as linked-slack, not you', async () => {
    const { org, agent } = await setupWorkspace();
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [{ channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] }],
    });

    const sql = getTestDb();
    const rows = await resolveBoundChannelRows(sql, {
      organizationId: org.id,
      agentId: agent.agentId,
    });
    // Requester is NOT Alice → Alice is a linked-Slack member, never "you".
    const audiences = await getChannelAudiences(sql, {
      organizationId: org.id,
      userId: 'someone-else',
      rows,
    });
    const eng = audiences.find((a) => a.channelId === 'C01ENG');
    const alice = eng?.members.find((m) => m.displayName === 'Alice');
    expect(alice?.isYou).toBe(false);
    expect(alice?.source).toBe('linked-slack');
  });
});
