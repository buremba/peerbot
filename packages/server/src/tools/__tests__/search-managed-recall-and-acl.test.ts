/**
 * Item 2 (managed read-orphan) + Item 3 (surface author_entity_id) for chat recall.
 *
 * Item 2 — a MANAGED Slack install is a `connections` row with `slug=slackinst-…`
 * and `agent_id NULL`. `resolveBoundChannelRows` branch (A) resolves it ONLY via
 * the `agent_channel_bindings.connection_id` link — the legacy tuple fallback
 * joins `b.agent_id = ac.agent_id`, which can never match a NULL connection
 * agent_id. The one-shot connections-unify backfill links EXISTING bindings, but
 * a binding created at RUNTIME (post-deploy) gets `connection_id` only because
 * `ChannelBindingService.createBinding` now links it. These tests prove:
 *   - an UNLINKED managed binding (connection_id NULL) is an unrecallable orphan
 *     (the bug, documented as the red);
 *   - createBinding LINKS connection_id, so the managed install's transcript
 *     recalls + attributes correctly (the green / fix).
 *
 * Item 3 — `author_entity_id` is surfaced in recalled snippets, additively: the
 * ACL fence (per-user channel visibility) is unchanged — a graphed non-member
 * still sees nothing, a member sees the channel WITH its author attribution.
 */

import { normalizeSlackUserId } from "@lobu/connector-sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../__tests__/setup/test-db";
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  insertChatConnectionRow,
} from "../../__tests__/setup/test-fixtures";
import { buildSlackChannelGraph } from "../../authz/slack-channel-graph";
import { ChannelBindingService } from "../../gateway/channels/binding-service";
import { clearEntityLinkRulesCache } from "../../utils/entity-link-upsert";
import { initWorkspaceProvider } from "../../workspace";
import { search } from "../search";

const TEAM = "TMANAGED";
const MANAGED_CONN = "slackinst-recall-test";

type SearchCtx = Parameters<typeof search>[2];

async function seedManagedMessage(
  connectionId: string,
  channelId: string,
	text: string,
): Promise<void> {
  const sql = getTestDb();
  // channel_messages stores the BARE channel id; the binding stores the
  // platform-prefixed form (`slack:C…`).
	const bare = channelId.startsWith("slack:")
		? channelId.slice("slack:".length)
		: channelId;
  await sql`
    INSERT INTO channel_messages (
      organization_id, connection_id, platform, channel_id,
      platform_message_id, author_name, is_bot, text, occurred_at
    )
    SELECT c.organization_id, ${connectionId}, 'slack', ${bare},
           ${`${bare}-0`}, 'Alice', false, ${text}, NOW()
    FROM connections c WHERE c.slug = ${connectionId} LIMIT 1
  `;
}

describe("managed-install recall (Item 2) + author attribution surfacing (Item 3)", () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  async function setupManaged() {
		const org = await createTestOrganization({ name: "Managed Co" });
    const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
    // The agent that LINKS the channel (a real, non-null agent) — the managed
    // connection itself has agent_id NULL.
    const agent = await createTestAgent({ organizationId: org.id });
    await insertChatConnectionRow({
      id: MANAGED_CONN,
      organizationId: org.id,
			platform: "slack",
      agentId: null,
			credentialMode: "managed",
			status: "active",
      metadata: { teamId: TEAM },
    });
    await seedManagedMessage(
      MANAGED_CONN,
			"slack:CMANAGED",
			"We discussed the quarterly revenue forecast",
    );
    return { org, user, agent };
  }

	it("RED: an UNLINKED managed binding (connection_id NULL) is an unrecallable orphan", async () => {
    const { org, user, agent } = await setupManaged();
    const sql = getTestDb();
    // Bind WITHOUT the connection_id link (raw insert, the pre-fix shape).
    await sql`
      INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id)
      VALUES (${org.id}, ${agent.agentId}, 'slack', 'slack:CMANAGED', ${TEAM})
    `;

    const result = await search(
			{ query: "quarterly revenue", include_content: true },
      {} as Parameters<typeof search>[1],
			{
				organizationId: org.id,
				userId: user.id,
				agentId: agent.agentId,
			} as SearchCtx,
    );
    // The managed connection's agent_id is NULL → the tuple fallback can't match
    // and there is no connection_id link → branch (A) yields nothing.
    expect(result.conversation_messages ?? []).toHaveLength(0);
  });

	it("GREEN: createBinding LINKS connection_id, so the managed install recalls + attributes", async () => {
    const { org, user, agent } = await setupManaged();
    const sql = getTestDb();
		const [connection] = await sql`
		SELECT id FROM connections
		WHERE organization_id = ${org.id} AND slug = ${MANAGED_CONN}
	`;

    // The REAL runtime bind path — links connection_id to the active managed
    // connection for (org, slack, TEAM).
		await new ChannelBindingService().createBinding(
			agent.agentId,
			"slack",
			"slack:CMANAGED",
			TEAM,
			{
      organizationId: org.id,
				connectionId: String(connection.id),
			},
		);

    // The fix's load-bearing assertion: the binding is now linked to the managed
    // connection (this is what makes branch (A) resolve a NULL-agent install).
    const [binding] = (await sql`
      SELECT b.connection_id, c.slug
      FROM agent_channel_bindings b
      JOIN connections c ON c.id = b.connection_id
      WHERE b.organization_id = ${org.id} AND b.channel_id = 'slack:CMANAGED'
    `) as Array<{ connection_id: number; slug: string }>;
    expect(binding).toBeDefined();
    expect(binding.slug).toBe(MANAGED_CONN);

    const result = await search(
			{ query: "quarterly revenue", include_content: true },
      {} as Parameters<typeof search>[1],
			{
				organizationId: org.id,
				userId: user.id,
				agentId: agent.agentId,
			} as SearchCtx,
		);
		const channels = (result.conversation_messages ?? []).map(
			(m) => m.channel_id,
    );
		expect(channels).toContain("CMANAGED");
  });

	it("Item 3: surfaces author_entity_id additively without changing the ACL fence", async () => {
		const org = await createTestOrganization({ name: "Attr Recall Co" });
		const alice = await createTestUser({ name: "Alice" });
		await addUserToOrganization(alice.id, org.id, "owner");
    const agent = await createTestAgent({ organizationId: org.id });
    const sql = getTestDb();

    // BYO connection (agent_id set → tuple-resolves) + a graphed workspace.
		const CONN = "conn-attr-recall";
    await insertChatConnectionRow({
      id: CONN,
      organizationId: org.id,
			platform: "slack",
      agentId: agent.agentId,
			status: "active",
      metadata: { teamId: TEAM },
    });
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;

    // Alice signed in ($member with the team-scoped slack id) — the requester.
    const aliceMember = await createTestEntity({
			name: "Alice",
			entity_type: "$member",
      organization_id: org.id,
      created_by: alice.id,
    });
		const aliceSlack = normalizeSlackUserId(TEAM, "U01ALICE");
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES
        (${org.id}, ${aliceMember.id}, 'auth_user_id', ${alice.id}, 'auth:signup'),
        (${org.id}, ${aliceMember.id}, 'slack_user_id', ${aliceSlack}, 'connector:slack')
    `;

    // The author of the recalled message — a person already attributed.
    const author = await createTestEntity({
			name: "Bob",
			entity_type: "person",
      organization_id: org.id,
      created_by: alice.id,
    });

    // Bind both channels; Alice is a member of #eng only.
		for (const ch of ["C01ENG", "C01SEC"]) {
      await sql`
        INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, connection_id)
        SELECT ${org.id}, ${agent.agentId}, 'slack', ${`slack:${ch}`}, ${TEAM}, id
        FROM connections
        WHERE organization_id = ${org.id} AND slug = ${`agentconn-${CONN}`} AND deleted_at IS NULL
      `;
    }
    await sql`
      INSERT INTO channel_messages (
        organization_id, connection_id, platform, channel_id,
        platform_message_id, author_name, author_entity_id, is_bot, text, occurred_at
      ) VALUES
        (${org.id}, ${CONN}, 'slack', 'C01ENG', 'eng-0', 'Bob', ${author.id}, false,
         'We discussed the quarterly revenue forecast', NOW()),
        (${org.id}, ${CONN}, 'slack', 'C01SEC', 'sec-0', 'Bob', ${author.id}, false,
         'Secret: the quarterly revenue numbers are confidential', NOW())
    `;

    await buildSlackChannelGraph({
      organizationId: org.id,
      connectionId: CONN,
      teamId: TEAM,
      channels: [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: ["U01ALICE"] },
				{
					channelId: "C01SEC",
					name: "secret",
					isPrivate: true,
					memberSlackUserIds: ["U01BOB"],
				},
      ],
    });

    // Member: sees #eng only (ACL fence intact) AND the snippet carries the
    // surfaced author_entity_id.
    const asMember = await search(
			{ query: "quarterly revenue", include_content: true },
      {} as Parameters<typeof search>[1],
			{
				organizationId: org.id,
				userId: alice.id,
				agentId: agent.agentId,
			} as SearchCtx,
		);
		const memberChannels = (asMember.conversation_messages ?? []).map(
			(m) => m.channel_id,
		);
		expect(memberChannels).toContain("C01ENG");
		expect(memberChannels).not.toContain("C01SEC");
		const engSnippet = (asMember.conversation_messages ?? []).find(
			(m) => m.channel_id === "C01ENG",
    );
    expect(engSnippet?.author_entity_id).toBe(author.id);

    // Non-member: the graphed connection fails closed (Item 3 didn't widen it).
    const asIntruder = await search(
			{ query: "quarterly revenue", include_content: true },
      {} as Parameters<typeof search>[1],
			{
				organizationId: org.id,
				userId: "intruder-user-id",
				agentId: agent.agentId,
			} as SearchCtx,
    );
    expect(asIntruder.conversation_messages ?? []).toHaveLength(0);
  });
});
