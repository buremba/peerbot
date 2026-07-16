/**
 * `listAgentThreads({ scope: "all" })` — the cross-platform activity feed.
 *
 * Verifies that scope=all surfaces, for one agent in one org:
 *   - the requesting user's own WEB threads (platform "web"),
 *   - PLATFORM conversations (e.g. `slack:…`) tagged with the derived platform,
 *   - one WATCHER entry per watcher (platform "watcher", carrying watcherId),
 * sorted newest-first — and that a watcher's per-run snapshot never leaks in as
 * its own platform row. Also drives the two read endpoints the feed links to:
 * readConversationMessages (platform, by raw id) and readWatcherRunThreads.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	listAgentThreads,
	readConversationMessages,
} from "../../gateway/services/agent-thread-list";
import { buildApiConversationId } from "../../gateway/services/api-conversation-id";
import { readWatcherRunThreads } from "../../gateway/services/watcher-run-thread";
import { insertEvent } from "../../utils/insert-event";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../setup/test-fixtures";

const AGENT = "thread-list-scope-all-agent";
const SLACK_CONV = "slack:C123:1781641725.28"; // channel C123 — agent is bound to it
const SLACK_UNBOUND_CONV = "slack:CSECRET:1781641725.99"; // channel the agent is NOT bound to
const WATCHER_ID = 990001;

function sessionJsonl(text: string): string {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			timestamp: "2026-06-28T00:00:00Z",
			cwd: "/w",
		}),
		JSON.stringify({
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-06-28T00:00:01Z",
			message: { role: "user", content: [{ type: "text", text }] },
		}),
	].join("\n");
}

describe("listAgentThreads scope=all", () => {
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
		const sql = getTestDb();

		// A transcript snapshot backs the read endpoints (readConversationMessages,
		// readWatcherRunThreads) and the watcher derivation. The sidebar LISTING,
		// however, now reads the `conversations` entity — so a conversation only
		// appears in listAgentThreads if it ALSO has a conversations row (which the
		// gateway dual-writes on every turn). insertSnapshot writes both by default;
		// pass listed=false for the watcher run (stays derived, no entity row).
		const insertSnapshot = async (
			conversationId: string,
			text: string,
			at: string,
			entity?: {
				platform: string;
				kind: "owned" | "platform";
				userId: string | null;
			},
		) => {
			const [run] = await sql<{ id: number }[]>`
        INSERT INTO runs (run_type, status, organization_id, created_at, completed_at, run_at)
        VALUES ('chat_message', 'completed', ${org}, ${at}, ${at}, ${at})
        RETURNING id`;
			const jsonl = sessionJsonl(text);
			await sql`
        INSERT INTO agent_transcript_snapshot
          (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
        VALUES (${org}, ${AGENT}, ${conversationId}, ${run.id}, ${jsonl}, ${Buffer.byteLength(jsonl)}, 'completed', ${at})`;
			if (entity) {
				await sql`
          INSERT INTO conversations
            (organization_id, agent_id, platform, conversation_id,
             kind, user_id, title, last_activity_at, created_at)
          VALUES (${org}, ${AGENT}, ${entity.platform},
                  ${conversationId}, ${entity.kind}, ${entity.userId}, ${text},
                  ${at}, ${at})`;
			}
		};

		// The requesting user's own web thread.
		await insertSnapshot(
			buildApiConversationId({
				agentId: AGENT,
				userId,
				organizationId: org,
				threadId: "webthread",
			}),
			"hello from web",
			"2026-06-28T01:00:00Z",
			{ platform: "web", kind: "owned", userId },
		);
		// The agent is bound to channel C123 (per-agent fence) — so its transcript
		// is listable; CSECRET has no binding and must never surface.
		const connId = `conn_${WATCHER_ID}`;
		await insertChatConnectionRow({
			id: connId,
			organizationId: org,
			agentId: AGENT,
			platform: "slack",
			status: "active",
		});
		await sql`
      INSERT INTO agent_channel_bindings (organization_id, agent_id, platform, channel_id, team_id, connection_id)
      SELECT ${org}, ${AGENT}, 'slack', 'slack:C123', 'T1', id
      FROM connections
      WHERE organization_id = ${org} AND slug = ${`agentconn-${connId}`} AND deleted_at IS NULL`;

		// A bound Slack conversation (newest) + an UNBOUND one. Both get a
		// conversations row (the gateway dual-writes every platform turn); the
		// UNBOUND one must still be fenced out by isConversationVisible at listing
		// time — proving the ACL gate runs on the entity, not just on the old
		// snapshot-derived path.
		await insertSnapshot(SLACK_CONV, "hello from slack", "2026-06-28T02:00:00Z", {
			platform: "slack",
			kind: "platform",
			userId: null,
		});
		await insertSnapshot(
			SLACK_UNBOUND_CONV,
			"secret channel transcript",
			"2026-06-28T03:00:00Z",
			{
				platform: "slack",
				kind: "platform",
				userId: null,
			},
		);
		// A watcher + one of its run snapshots.
		await sql`
      INSERT INTO watchers
        (id, organization_id, agent_id, created_by, watcher_group_id, name, status, notification_channel, notification_priority, min_cooldown_seconds, created_at, updated_at)
      VALUES (${WATCHER_ID}, ${org}, ${AGENT}, ${userId}, 0, 'Test Watcher', 'active', 'notification', 'normal', 0, now(), now())`;
		await insertSnapshot(
			`${AGENT}_watcher_${WATCHER_ID}_run_5`,
			"watcher run output",
			"2026-06-28T00:30:00Z",
		);
		const [approvalRun] = await sql<{ id: number }[]>`
			INSERT INTO runs
			  (run_type, status, organization_id, watcher_id, approval_status, action_key, created_at)
			VALUES
			  ('internal', 'pending', ${org}, ${WATCHER_ID}, 'pending', 'entity_field_change', now())
			RETURNING id`;
		await insertEvent({
			entityIds: [],
			organizationId: org,
			originId: `watcher-approval-${approvalRun.id}`,
			title: "Approve watcher change",
			content: "A watcher proposed changing a contact.",
			semanticType: "operation",
			runId: approvalRun.id,
			interactionType: "approval",
			interactionStatus: "pending",
			metadata: {
				action: "update",
				tool: "entity_field_change",
				resourceKind: "entity",
				fields: { email: "new@example.com" },
				attribution: "watcher",
			},
		});
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("returns web + platform + watcher entries with correct platforms, newest-first", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});
		const byPlatform = new Map(threads.map((t) => [t.platform, t]));

		expect(byPlatform.get("web")?.id).toBe("webthread");

		const slack = byPlatform.get("slack");
		expect(slack?.id).toBe(SLACK_CONV);
		expect(slack?.conversationId).toBe(SLACK_CONV);

		const watcher = byPlatform.get("watcher");
		expect(watcher?.watcherId).toBe(WATCHER_ID);
		expect(watcher?.title).toBe("Test Watcher");

		// Newest VISIBLE is the bound Slack channel at 02:00 — the unbound channel
		// at 03:00 is fenced out, so it must not take the top slot (or any slot).
		expect(threads[0]?.platform).toBe("slack");
		expect(threads[0]?.id).toBe(SLACK_CONV);

		// A watcher's per-run snapshot must NOT surface as its own platform row.
		expect(threads.some((t) => t.id.includes("_watcher_"))).toBe(false);
	});

	it("fences out platform conversations on channels the agent isn't bound to", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "all",
		});
		// CSECRET has no binding — its transcript must never be listed, even though
		// it's the most recent snapshot.
		expect(threads.some((t) => t.id === SLACK_UNBOUND_CONV)).toBe(false);
		expect(threads.some((t) => t.conversationId === SLACK_UNBOUND_CONV)).toBe(
			false,
		);
	});

	it("scope=user (default) excludes platform + watcher conversations", async () => {
		const threads = await listAgentThreads({
			agentId: AGENT,
			organizationId: org,
			userId,
			scope: "user",
		});
		expect(threads.every((t) => t.platform === "web")).toBe(true);
		expect(threads.some((t) => t.id === "webthread")).toBe(true);
	});

	it("reads a platform conversation read-only by its raw id", async () => {
		const data = await readConversationMessages({
			agentId: AGENT,
			organizationId: org,
			conversationId: SLACK_CONV,
			cursor: "",
			limit: 200,
		});
		expect(JSON.stringify(data.messages)).toContain("hello from slack");
	});

	it("readWatcherRunThreads returns the watcher's runs", async () => {
		const data = await readWatcherRunThreads({
			agentId: AGENT,
			organizationId: org,
			watcherId: WATCHER_ID,
			limit: 20,
		});
		expect(data.runs).toHaveLength(1);
		expect(JSON.stringify(data.runs[0]?.messages)).toContain(
			"watcher run output",
		);
		expect(data.interactions).toEqual([
				expect.objectContaining({
					type: "tool-approval",
					eventId: expect.any(Number),
					action: "update",
				fields: { email: "new@example.com" },
				attribution: "watcher",
				resourceKind: "entity",
			}),
		]);
	});
});
