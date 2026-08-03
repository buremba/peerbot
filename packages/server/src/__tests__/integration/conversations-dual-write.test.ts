/**
 * End-to-end for the `conversations` entity dual-write → listing round trip.
 *
 * Exercises the exact store calls the gateway dispatch makes (upsertConversation)
 * and the sidebar read (listConversations / listAgentThreads), proving:
 *   - first turn INSERTs a row; a later turn bumps last_activity_at and keeps the
 *     original title (COALESCE), never clobbering with a null,
 *   - a platform conversation is keyed by (platform, conversation_id),
 *   - behavior conversation ids are excluded (they stay derived),
 *   - platform is stored explicitly (an opaque no-colon id is not mislabeled),
 *   - listAgentThreads (scope=user) surfaces the owned row via the entity.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAgentThreads } from "../../gateway/services/agent-thread-list";
import { buildApiConversationId } from "../../gateway/services/api-conversation-id";
import {
	classifyConversation,
	isBehaviorConversationId,
	listConversations,
	resolveConversationLocationLabel,
	upsertConversation,
} from "../../gateway/services/conversations-store";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";

const AGENT = "conversations-dual-write-agent";

describe("conversations dual-write", () => {
	let org: string;
	let userId: string;

	beforeAll(async () => {
		org = (await createTestOrganization()).id;
		userId = (await createTestUser()).id;
		await createTestAgent({
			organizationId: org,
			agentId: AGENT,
			ownerUserId: userId,
		});
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("classifies + excludes behavior ids like the dispatch guard", () => {
		expect(classifyConversation("api")).toEqual({
			kind: "owned",
			storedPlatform: "web",
		});
		expect(classifyConversation("slack")).toEqual({
			kind: "platform",
			storedPlatform: "slack",
		});
		// classified from the explicit platform, not id punctuation: a non-api
		// platform whose channel id has no colon is still a platform conversation.
		expect(classifyConversation("telegram").kind).toBe("platform");
		// platform is lowercase-canonicalized (it's part of the PK).
		expect(classifyConversation("Slack").storedPlatform).toBe("slack");
		expect(isBehaviorConversationId(`${AGENT}_behavior_5_run_9`)).toBe(true);
		expect(isBehaviorConversationId("ag_u_o_thread")).toBe(false);
	});

	it("INSERTs on first turn and refreshes on later turns without losing title", async () => {
		const conv = buildApiConversationId({
			agentId: AGENT,
			userId,
			organizationId: org,
			threadId: "dw-thread",
		});
		await upsertConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "web",
			conversationId: conv,
			threadId: "dw-thread",
			kind: "owned",
			userId,
			title: "first message",
			lastActivityAt: new Date("2026-06-28T01:00:00Z"),
		});
		// Later turn: newer activity, and a null title must NOT clobber the first.
		await upsertConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "web",
			conversationId: conv,
			threadId: "dw-thread",
			kind: "owned",
			userId,
			title: null,
			lastActivityAt: new Date("2026-06-28T05:00:00Z"),
		});

		const sql = getTestDb();
		const rows = await sql<
			{ title: string | null; last_activity_at: Date }[]
		>`
      SELECT title, last_activity_at FROM conversations
      WHERE organization_id = ${org} AND agent_id = ${AGENT}
        AND conversation_id = ${conv}`;
		expect(rows).toHaveLength(1);
		expect(rows[0].title).toBe("first message");
		expect(rows[0].last_activity_at.toISOString()).toBe(
			"2026-06-28T05:00:00.000Z",
		);
	});

	it("concurrent first-turns on the same conversation converge to one row (GREATEST/COALESCE)", async () => {
		// Two pods dispatch turns for the same NEW conversation at once: one wins
		// the INSERT, the other takes ON CONFLICT DO UPDATE. The row must be
		// singular, keep the newest last_activity_at, and keep a non-null title
		// even if one racer had none.
		const conv = buildApiConversationId({
			agentId: AGENT,
			userId,
			organizationId: org,
			threadId: "race-thread",
		});
		const base = {
			organizationId: org,
			agentId: AGENT,
			platform: "web",
			conversationId: conv,
			threadId: "race-thread",
			kind: "owned" as const,
			userId,
		};
		await Promise.all([
			upsertConversation({
				...base,
				title: null,
				lastActivityAt: new Date("2026-06-28T03:00:00Z"),
			}),
			upsertConversation({
				...base,
				title: "the real title",
				lastActivityAt: new Date("2026-06-28T09:00:00Z"),
			}),
		]);

		const sql = getTestDb();
		const rows = await sql<
			{ title: string | null; last_activity_at: Date }[]
		>`
      SELECT title, last_activity_at FROM conversations
      WHERE organization_id = ${org} AND agent_id = ${AGENT}
        AND conversation_id = ${conv}`;
		expect(rows).toHaveLength(1);
		expect(rows[0].title).toBe("the real title");
		expect(rows[0].last_activity_at.toISOString()).toBe(
			"2026-06-28T09:00:00.000Z",
		);
	});

	it("keys a platform conversation by (platform, conversation_id)", async () => {
		await upsertConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "slack",
			conversationId: "slack:CX:ts",
			threadId: null,
			kind: "platform",
			userId: null,
			title: "a slack thread",
			locationLabel: "#old-name",
			lastActivityAt: new Date("2026-06-28T02:00:00Z"),
		});
		await upsertConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "slack",
			conversationId: "slack:CX:ts",
			threadId: null,
			kind: "platform",
			userId: null,
			title: null,
			locationLabel: "#renamed-channel",
			lastActivityAt: new Date("2026-06-28T03:00:00Z"),
		});
		const rows = await listConversations({
			organizationId: org,
			agentId: AGENT,
			scope: "all",
			userId,
		});
		const row = rows.filter((r) => r.conversationId === "slack:CX:ts");
		// One conversation, one row — the connection that delivered it is not part
		// of identity, so re-delivery through a different connection does not fork.
		expect(row).toHaveLength(1);
		expect(row[0]?.platform).toBe("slack");
		expect(row[0]?.locationLabel).toBe("#renamed-channel");
	});

	it("resolves channel and direct-message location labels", async () => {
		const channel = await createTestEntity({
			organization_id: org,
			name: "launch-room",
		});
		const sql = getTestDb();
		await sql`
			INSERT INTO entity_identities
				(organization_id, entity_id, namespace, identifier, source_connector)
			VALUES (${org}, ${channel.id}, 'slack_channel_id', 'TLOC:CLOC', 'connector:slack')
		`;

		expect(
			await resolveConversationLocationLabel({
				organizationId: org,
				platform: "slack",
				teamId: "TLOC",
				channelId: "CLOC",
				isDirect: false,
			}),
		).toBe("#launch-room");
		expect(
			await resolveConversationLocationLabel({
				organizationId: org,
				platform: "slack",
				teamId: "TLOC",
				channelId: "DM1",
				isDirect: true,
				senderDisplayName: "  Ada  ",
			}),
		).toBe("Ada");
		expect(
			await resolveConversationLocationLabel({
				organizationId: org,
				platform: "slack",
				teamId: "TLOC",
				channelId: "UNKNOWN",
				isDirect: false,
			}),
		).toBeNull();
	});

	it("treats an identifier-only channel entity name as unresolved", async () => {
		// A channel graphed before its display name was known is named after its
		// own identifier — the bare id (ACL sync's `c.name ?? c.channelId`) or the
		// full team-scoped key (`displayName ?? key`). Neither is a location, and
		// `#TLOC:CKEY` in the sidebar is worse than no label at all.
		const sql = getTestDb();
		for (const [channelId, name] of [
			["CBARE", "CBARE"],
			["CKEY", "TLOC:CKEY"],
		]) {
			const entity = await createTestEntity({ organization_id: org, name });
			await sql`
				INSERT INTO entity_identities
					(organization_id, entity_id, namespace, identifier, source_connector)
				VALUES (${org}, ${entity.id}, 'slack_channel_id', ${`TLOC:${channelId}`}, 'connector:slack')
			`;
			expect(
				await resolveConversationLocationLabel({
					organizationId: org,
					platform: "slack",
					teamId: "TLOC",
					channelId,
					isDirect: false,
				}),
			).toBeNull();
		}
	});

	it("returns the EXPLICIT stored platform for an opaque no-colon platform id", async () => {
		// gchat/teams channel ids aren't colon-prefixed; the old id-parsing
		// deriveConversationPlatform would mislabel them "web". The entity stores
		// the platform explicitly, and the sidebar labels from it.
		await upsertConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "gchat",
			conversationId: "spaces_AAA_threads_BBB",
			threadId: null,
			kind: "platform",
			userId: null,
			title: "gchat space",
			lastActivityAt: new Date("2026-06-28T04:00:00Z"),
		});
		const rows = await listConversations({
			organizationId: org,
			agentId: AGENT,
			scope: "all",
			userId,
		});
		const gchat = rows.find(
			(r) => r.conversationId === "spaces_AAA_threads_BBB",
		);
		expect(gchat?.platform).toBe("gchat");
	});

	it("surfaces the owned conversation in the sidebar (scope=user)", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "user",
		});
		expect(threads.every((t) => t.platform === "web")).toBe(true);
		expect(threads.some((t) => t.id === "dw-thread")).toBe(true);
		// platform + behavior rows never leak into scope=user
		expect(threads.some((t) => t.conversationId === "slack:CX:ts")).toBe(false);
	});
});
