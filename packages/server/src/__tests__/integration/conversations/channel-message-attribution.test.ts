/**
 * Store-only sender attribution for the durable chat transcript.
 *
 * `persistChannelMessage` resolves a real (non-bot) author to its person/$member
 * entity and stamps `channel_messages.author_entity_id` — WITHOUT emitting an
 * event or touching the embed pipeline. Invariants proved here:
 *   1. a known Slack sender (existing person, slack_user_id=T:U) attributes to it;
 *   2. an unknown non-bot sender mints a NEW person; a bot post never attributes;
 *   3. a sender with no team id is never attributed (no malformed, team-less key);
 *   4. cross-source collapse (#1646): a signed-in human is a $member carrying the
 *      same slack_user_id, so attribution lands on the $member — no dup person.
 */

import { normalizeSlackUserId } from '@lobu/connectors/slack-identity';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { persistChannelMessage } from '../../../gateway/connections/channel-transcript';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const TEAM = 'T1ACME';

/** Ensure the org has a `person` entity type so auto-create can resolve it. */
async function ensurePersonType(orgId: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${orgId}, 'person', 'Person', current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
  `;
}

async function addIdentity(opts: {
  orgId: string;
  entityId: number;
  namespace: string;
  identifier: string;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
    VALUES (${opts.orgId}, ${opts.entityId}, ${opts.namespace}, ${opts.identifier}, 'connector:slack')
  `;
}

/** Capture one inbound message and read its attribution back. */
async function captureAndRead(params: {
  orgId: string;
  connectionId: string;
  channelId: string;
  authorId: string | null;
  teamId: string | null;
  isBot: boolean;
  text: string;
}): Promise<number | null> {
  const sql = getTestDb();
  await persistChannelMessage({
    organizationId: params.orgId,
    connectionId: params.connectionId,
    platform: 'slack',
    channelId: params.channelId,
    platformMessageId: `${params.channelId}-${Math.random().toString(36).slice(2)}`,
    authorId: params.authorId,
    authorName: 'Sender',
    teamId: params.teamId,
    isBot: params.isBot,
    text: params.text,
    occurredAt: new Date(),
  });
  const rows = (await sql`
    SELECT author_entity_id, team_id
    FROM channel_messages
    WHERE organization_id = ${params.orgId} AND connection_id = ${params.connectionId}
    ORDER BY id DESC LIMIT 1
  `) as Array<{ author_entity_id: number | string | null; team_id: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0].author_entity_id == null ? null : Number(rows[0].author_entity_id);
}

describe('channel_messages sender attribution', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('attributes a known Slack sender (existing person, slack_user_id=T:U)', async () => {
    const org = await createTestOrganization({ name: 'Attr Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    const person = await createTestEntity({
      name: 'Alice',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    const slackId = normalizeSlackUserId(TEAM, 'U1ALICE');
    await addIdentity({
      orgId: org.id,
      entityId: person.id,
      namespace: 'slack_user_id',
      identifier: slackId as string,
    });

    const resolved = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-attr',
      channelId: 'C1',
      authorId: 'U1ALICE',
      teamId: TEAM,
      isBot: false,
      text: 'hello from alice',
    });
    expect(resolved).toBe(person.id);
  });

  it('mints a new person for an unknown non-bot sender, and never attributes a bot', async () => {
    const org = await createTestOrganization({ name: 'Mint Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);
    const sql = getTestDb();

    // Unknown non-bot → a fresh person is minted and attributed.
    const minted = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-mint',
      channelId: 'C1',
      authorId: 'U2BOB',
      teamId: TEAM,
      isBot: false,
      text: 'first message from bob',
    });
    expect(minted).not.toBeNull();

    const slackId = normalizeSlackUserId(TEAM, 'U2BOB');
    const idRows = (await sql`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'slack_user_id' AND identifier = ${slackId}
    `) as Array<{ entity_id: number | string }>;
    expect(idRows).toHaveLength(1);
    expect(Number(idRows[0].entity_id)).toBe(minted);

    // A bot post is never attributed.
    const botAttr = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-mint',
      channelId: 'C1',
      authorId: 'B1BOT',
      teamId: TEAM,
      isBot: true,
      text: 'beep boop',
    });
    expect(botAttr).toBeNull();
  });

  it('never attributes (or mints a malformed key) when there is no team id', async () => {
    const org = await createTestOrganization({ name: 'NoTeam Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);
    const sql = getTestDb();

    const resolved = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-noteam',
      channelId: 'C1',
      authorId: 'U3CAROL',
      teamId: null,
      isBot: false,
      text: 'no team here',
    });
    expect(resolved).toBeNull();

    // No identity row was written for a bare, team-less Slack id.
    const idRows = (await sql`
      SELECT 1 FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'slack_user_id'
    `) as Array<unknown>;
    expect(idRows).toHaveLength(0);
  });

  it('collapses onto a signed-in $member carrying the same slack_user_id (no dup person)', async () => {
    const org = await createTestOrganization({ name: 'Collapse Org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensurePersonType(org.id);
    const sql = getTestDb();

    // A signed-in human: $member carrying auth_user_id + the team-scoped slack id.
    const member = await createTestEntity({
      name: 'Dave',
      entity_type: '$member',
      organization_id: org.id,
      created_by: user.id,
    });
    const slackId = normalizeSlackUserId(TEAM, 'U4DAVE');
    await addIdentity({
      orgId: org.id,
      entityId: member.id,
      namespace: 'auth_user_id',
      identifier: user.id,
    });
    await addIdentity({
      orgId: org.id,
      entityId: member.id,
      namespace: 'slack_user_id',
      identifier: slackId as string,
    });

    const resolved = await captureAndRead({
      orgId: org.id,
      connectionId: 'conn-collapse',
      channelId: 'C1',
      authorId: 'U4DAVE',
      teamId: TEAM,
      isBot: false,
      text: 'dave in slack',
    });
    expect(resolved).toBe(member.id);

    // No person entity was minted for the same identity — attribution and ACL
    // converge on the single $member.
    const personRows = (await sql`
      SELECT e.id FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id AND et.slug = 'person'
      WHERE e.organization_id = ${org.id} AND e.deleted_at IS NULL
    `) as Array<unknown>;
    expect(personRows).toHaveLength(0);
  });
});
