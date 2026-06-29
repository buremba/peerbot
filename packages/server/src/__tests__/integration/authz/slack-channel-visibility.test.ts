/**
 * Slack channel visibility gate — END TO END through `search_memory`.
 *
 * Proves the authz program's core guarantee for chat recall: an agent bound to
 * BOTH a channel the user belongs to (#eng) and one they DON'T (#secret)
 * surfaces only #eng's transcript when that user asks — connection-sourced data
 * never reaches a user beyond their access in the source system. Also proves the
 * two fail-closed edges (unresolved requester sees nothing of an enforced
 * connection) and that a connection WITHOUT a materialized ACL graph keeps the
 * legacy per-agent behavior (no regression until a workspace is graphed).
 */

import { normalizeSlackUserId } from '@lobu/connector-sdk';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syncSlackConnectionAcl } from '../../../authz/slack-acl-sync';
import { buildSlackChannelGraph } from '../../../authz/slack-channel-graph';
import { search } from '../../../tools/search';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { ensureMemberEntity } from '../../../utils/member-entity';
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

type SearchCtx = Parameters<typeof search>[2];

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

/** Bind a channel to the agent (with team id) and drop one matching message. */
async function bindChannel(opts: {
  orgId: string;
  agentId: string;
  channelId: string;
  text: string;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id)
    VALUES (${opts.orgId}, ${opts.agentId}, 'slack', ${opts.channelId}, ${TEAM})
  `;
  await sql`
    INSERT INTO channel_messages (
      organization_id, connection_id, platform, channel_id,
      platform_message_id, author_name, is_bot, text, occurred_at
    ) VALUES (
      ${opts.orgId}, ${CONN}, 'slack', ${opts.channelId},
      ${`${opts.channelId}-0`}, 'Alice', false, ${opts.text}, NOW()
    )
  `;
}

function searchAs(orgId: string, userId: string | null, agentId: string) {
  return search(
    { query: 'quarterly revenue', include_content: true },
    {} as Parameters<typeof search>[1],
    { organizationId: orgId, userId, agentId } as SearchCtx,
  );
}

describe('slack channel visibility gate (e2e via search_memory)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  async function setupWorkspace() {
    const org = await createTestOrganization({ name: 'Acme' });
    const alice = await createTestUser({ name: 'Alice' });
    await addUserToOrganization(alice.id, org.id, 'owner');
    const agent = await createTestAgent({ organizationId: org.id });

    // The builder auto-creates `person` entities for channel members; the type
    // must exist in the org (prod seeds default types at org creation).
    const sqlType = getTestDb();
    await sqlType`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;

    // The bot connection + bindings to BOTH channels.
    const sql = getTestDb();
    await sql`
      INSERT INTO agent_connections (id, agent_id, platform, organization_id, status)
      VALUES (${CONN}, ${agent.agentId}, 'slack', ${org.id}, 'active')
    `;
    await bindChannel({
      orgId: org.id,
      agentId: agent.agentId,
      channelId: 'C01ENG',
      text: 'We discussed the quarterly revenue forecast',
    });
    await bindChannel({
      orgId: org.id,
      agentId: agent.agentId,
      channelId: 'C01SEC',
      text: 'Secret: the quarterly revenue numbers are confidential',
    });

    // Alice signed in + linked Slack.
    await seedSignedInMember({
      orgId: org.id,
      userId: alice.id,
      name: 'Alice',
      slackUserId: 'U01ALICE',
    });
    return { org, alice, agent };
  }

  it('surfaces only the channel the user belongs to once the graph is enforced', async () => {
    const { org, alice, agent } = await setupWorkspace();

    // Alice is a member of #eng only. Bob is the lone member of #secret.
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [
        { channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] },
        {
          channelId: 'C01SEC',
          name: 'secret',
          isPrivate: true,
          memberSlackUserIds: ['U01BOB'],
        },
      ],
    });

    const result = await searchAs(org.id, alice.id, agent.agentId);
    const channels = (result.conversation_messages ?? []).map((m) => m.channel_id);
    expect(channels).toContain('C01ENG');
    expect(channels).not.toContain('C01SEC');
  });

  it('fails closed: an unresolved requester sees NONE of an enforced connection', async () => {
    const { org, agent } = await setupWorkspace();
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [
        { channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] },
        {
          channelId: 'C01SEC',
          name: 'secret',
          isPrivate: true,
          memberSlackUserIds: ['U01BOB'],
        },
      ],
    });

    // A user with no $member in this org → resolves to nothing → fail closed.
    const result = await searchAs(org.id, 'intruder-user-id', agent.agentId);
    expect(result.conversation_messages ?? []).toHaveLength(0);
  });

  it('revokes on departure: a member who leaves #eng loses recall on the next sync', async () => {
    const { org, alice, agent } = await setupWorkspace();
    // Alice is in #eng → can recall it.
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [{ channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] }],
    });
    const before = await searchAs(org.id, alice.id, agent.agentId);
    expect((before.conversation_messages ?? []).map((m) => m.channel_id)).toContain('C01ENG');

    // Alice leaves #eng → re-sync with the new membership (just Bob).
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [{ channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01BOB'] }],
    });
    const after = await searchAs(org.id, alice.id, agent.agentId);
    expect((after.conversation_messages ?? []).map((m) => m.channel_id)).not.toContain('C01ENG');
  });

  it('no regression: WITHOUT a materialized graph the legacy per-agent fence applies', async () => {
    const { org, alice, agent } = await setupWorkspace();
    // No buildSlackChannelGraph → connection is not enforced → both channels recall.
    const result = await searchAs(org.id, alice.id, agent.agentId);
    const channels = (result.conversation_messages ?? []).map((m) => m.channel_id);
    expect(channels).toContain('C01ENG');
    expect(channels).toContain('C01SEC');
  });

  it('fails closed when the graph ages past the freshness window (no stale-membership re-exposure)', async () => {
    const { org, alice, agent } = await setupWorkspace();
    // Alice is a member of #eng → a FRESH graph lets her recall it.
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [{ channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01ALICE'] }],
    });
    const fresh = await searchAs(org.id, alice.id, agent.agentId);
    expect((fresh.conversation_messages ?? []).map((m) => m.channel_id)).toContain('C01ENG');

    // The sync stops: age this connection's graph past the 60-min window. An
    // onboarded-but-stale connection must FAIL CLOSED (drop its channels), NOT
    // fall back to the legacy fence — serving stale membership is the hole the
    // age-based gate closes. Alice loses recall even though she's still a member.
    const sql = getTestDb();
    await sql`
      UPDATE authz_source_acl_state
      SET last_synced_at = current_timestamp - interval '90 minutes'
      WHERE organization_id = ${org.id} AND connection_id = ${CONN}
    `;
    const stale = await searchAs(org.id, alice.id, agent.agentId);
    expect(stale.conversation_messages ?? []).toHaveLength(0);
  });

  it('enforces through the PRODUCTION sync path (syncSlackConnectionAcl), not just the test builder', async () => {
    const { org, alice, agent } = await setupWorkspace();

    // Drive the real production caller with a stubbed Slack API + token resolver,
    // exactly as runSlackAclSyncTick wires it in prod. THIS is what activates the
    // gate for a live connection — buildSlackChannelGraph is never called by hand.
    const membersByChannel: Record<string, string[]> = {
      C01ENG: ['U01ALICE'],
      C01SEC: ['U01BOB'],
    };
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async (_token, channelId) => membersByChannel[channelId] ?? [],
        },
        resolveBotIdentity: async () => ({ token: 'xoxb-test-token', botUserId: null }),
      },
      { connectionId: CONN, organizationId: org.id },
    );
    expect(result.ok).toBe(true);
    expect(result.channelsSynced).toBe(2);

    // The gate now enforces off the materialized graph: Alice (member of #eng
    // only) recalls #eng, never #secret.
    const search1 = await searchAs(org.id, alice.id, agent.agentId);
    const channels = (search1.conversation_messages ?? []).map((m) => m.channel_id);
    expect(channels).toContain('C01ENG');
    expect(channels).not.toContain('C01SEC');
  });

  it('scopes the production sync to the connection workspace — a second workspace never leaks in', async () => {
    const { org, agent } = await setupWorkspace();
    const sql = getTestDb();
    // CONN is the Acme (T01ACME) workspace bot.
    await sql`UPDATE agent_connections SET metadata = ${sql.json({ teamId: TEAM })} WHERE id = ${CONN}`;
    // A binding to a channel in a DIFFERENT workspace (the same agent's second
    // Slack connection) must NOT be synced under CONN — otherwise CONN would
    // fetch it with the wrong token and fail closed, or stamp it under itself.
    await sql`
      INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id)
      VALUES (${org.id}, ${agent.agentId}, 'slack', 'C02FOREIGN', 'T02OTHER')
    `;

    const fetched: string[] = [];
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async (_t, channelId) => {
            fetched.push(channelId);
            return ['U01ALICE'];
          },
        },
        // Only the Acme workspace has a token — reaching T02OTHER would fail closed.
        resolveBotIdentity: async ({ teamId }) =>
          teamId === TEAM ? { token: 'xoxb-test-token', botUserId: null } : null,
      },
      { connectionId: CONN, organizationId: org.id },
    );

    // The foreign channel is excluded, so the sync stays green and only Acme's
    // channels are fetched. Pre-fix this threw (no token for T02OTHER) → ok=false.
    expect(result.ok).toBe(true);
    expect(result.channelsSynced).toBe(2);
    expect(fetched.sort()).toEqual(['C01ENG', 'C01SEC']);
  });

  it('resolves a member provisioned through the REAL path (ensureMemberEntity), not a hand-seeded identity', async () => {
    // setupWorkspace seeds Alice via seedSignedInMember, which writes the
    // auth_user_id identity by hand. THIS test instead provisions a second user
    // (Carol) the way production does — through ensureMemberEntity (the
    // shared-org join path) — and DOES NOT touch entity_identities for her
    // auth_user_id. If ensureMemberEntity stops writing that identity, Carol
    // resolves to nothing and the gate fails closed → this test goes red. That
    // is the production gap the hand-seeded tests masked.
    const { org, agent } = await setupWorkspace();
    const carol = await createTestUser({ name: 'Carol' });
    await addUserToOrganization(carol.id, org.id, 'member');

    // Real provisioning — writes the $member entity AND its auth_user_id identity.
    await ensureMemberEntity({
      organizationId: org.id,
      userId: carol.id,
      name: 'Carol',
      email: 'carol@acme.test',
      role: 'member',
      status: 'active',
    });
    // The Slack link is a separate real mechanism (Connect-my-DM / email claim);
    // attach it so the channel member collapses onto Carol's $member.
    const sql = getTestDb();
    const memberRows = await sql<{ entity_id: number }>`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'email' AND identifier = 'carol@acme.test'
        AND deleted_at IS NULL
      LIMIT 1
    `;
    // The email identity is written by ensureMemberEntity-adjacent provisioning;
    // fall back to looking the member up by metadata if email identity is absent.
    let memberEntityId: number | null = memberRows.length > 0 ? Number(memberRows[0].entity_id) : null;
    if (memberEntityId === null) {
      const byMeta = await sql<{ id: number }>`
        SELECT e.id FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id AND et.slug = '$member'
        WHERE e.organization_id = ${org.id}
          AND e.metadata->>'email' = 'carol@acme.test'
          AND e.deleted_at IS NULL
        LIMIT 1
      `;
      memberEntityId = byMeta.length > 0 ? Number(byMeta[0].id) : null;
    }
    expect(memberEntityId).not.toBeNull();
    const combined = normalizeSlackUserId(TEAM, 'U01CAROL');
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${org.id}, ${memberEntityId}, 'slack_user_id', ${combined}, 'connector:slack')
    `;

    // Carol is a member of #eng only.
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [
        { channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01CAROL'] },
        { channelId: 'C01SEC', name: 'secret', isPrivate: true, memberSlackUserIds: ['U01BOB'] },
      ],
    });

    const result = await searchAs(org.id, carol.id, agent.agentId);
    const channels = (result.conversation_messages ?? []).map((m) => m.channel_id);
    expect(channels).toContain('C01ENG');
    expect(channels).not.toContain('C01SEC');
  });

  it('production sync FAILS CLOSED for an already-graphed connection when Slack fetch throws', async () => {
    const { org, alice, agent } = await setupWorkspace();
    // First a good sync so the connection has a materialized (enforced) graph.
    await syncSlackConnectionAcl(
      {
        slackWeb: { conversationMembers: async () => ['U01ALICE'] },
        resolveBotIdentity: async () => ({ token: 'xoxb-test-token', botUserId: null }),
      },
      { connectionId: CONN, organizationId: org.id },
    );
    expect((await searchAs(org.id, alice.id, agent.agentId)).conversation_messages ?? []).not
      .toHaveLength(0);

    // Slack outage on the next tick: ANY channel fetch throws → the sync must
    // mark the connection failed (not leave a half-synced graph), and the gate
    // then drops every channel until a later tick succeeds.
    const result = await syncSlackConnectionAcl(
      {
        slackWeb: {
          conversationMembers: async () => {
            throw new Error('slack outage');
          },
        },
        resolveBotIdentity: async () => ({ token: 'xoxb-test-token', botUserId: null }),
      },
      { connectionId: CONN, organizationId: org.id },
    );
    expect(result.ok).toBe(false);
    const after = await searchAs(org.id, alice.id, agent.agentId);
    expect(after.conversation_messages ?? []).toHaveLength(0);
  });

  it('resolves an in-Slack requester via slack_user_id when they have no auth identity', async () => {
    const { org, agent } = await setupWorkspace();
    // Dave is a Slack-only user (never signed in to the web app → no auth_user_id).
    // The graph auto-creates his person entity with a slack_user_id claim + a
    // member_of edge to #eng.
    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [
        { channelId: 'C01ENG', name: 'eng', memberSlackUserIds: ['U01DAVE'] },
        { channelId: 'C01SEC', name: 'secret', isPrivate: true, memberSlackUserIds: ['U01BOB'] },
      ],
    });

    // ctx.userId is Dave's bare Slack id (the in-Slack message author), NOT an
    // auth_user_id — the auth lookup misses, so this only passes via the
    // slack_user_id fallback. Without it, Dave fails closed and sees nothing.
    const result = await searchAs(org.id, 'U01DAVE', agent.agentId);
    const channels = (result.conversation_messages ?? []).map((m) => m.channel_id);
    expect(channels).toContain('C01ENG');
    expect(channels).not.toContain('C01SEC');
  });
});
