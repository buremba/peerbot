/**
 * Integration for the read helpers PR-C's `conversations.get` / `.send` depend
 * on, against real Postgres: getConversation (single-row PK read, soft-delete
 * hidden) and readConversationReply (terminal-outcome poll over the durable
 * `runs` thread-response rows — the cross-replica reply source for
 * `conversations.send({ wait: true })`). These exercise the exact SQL, including
 * the jsonb `?`/`->>'` matching on processedMessageIds and the string/jsonb cast
 * on action_input.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApiConversationId } from "../../gateway/services/api-conversation-id";
import {
	getConversation,
	readConversationReply,
	upsertConversation,
} from "../../gateway/services/conversations-store";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";

const AGENT = "conversations-store-reads-agent";

/** Insert a terminal thread-response run the worker would write on completion. */
async function insertThreadResponse(
	org: string,
	payload: Record<string, unknown>,
	status: "completed" | "failed",
): Promise<void> {
	const sql = getTestDb();
	await sql`
    INSERT INTO public.runs (organization_id, run_type, queue_name, status, action_input, created_at)
    VALUES (
      ${org}, 'chat_message', 'thread_response', ${status},
      ${sql.json(payload)}, now()
    )
  `;
}

describe("conversations-store read helpers", () => {
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

	it("getConversation returns a materialized row and null for a missing one", async () => {
		const conv = buildApiConversationId({
			agentId: AGENT,
			userId,
			organizationId: org,
			threadId: "get-thread",
		});
		await upsertConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "web",
			conversationId: conv,
			threadId: "get-thread",
			kind: "owned",
			userId,
			title: "a thread",
			lastActivityAt: new Date("2026-06-28T01:00:00Z"),
		});

		const row = await getConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "web",
			conversationId: conv,
		});
		expect(row?.conversationId).toBe(conv);
		expect(row?.threadId).toBe("get-thread");
		expect(row?.kind).toBe("owned");
		expect(row?.title).toBe("a thread");

		const missing = await getConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "web",
			conversationId: "does-not-exist",
		});
		expect(missing).toBeNull();
	});

	it("getConversation hides a soft-deleted (archived) row", async () => {
		const conv = "archived-conv";
		await upsertConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "web",
			conversationId: conv,
			threadId: null,
			kind: "owned",
			userId,
			title: "to archive",
			lastActivityAt: new Date("2026-06-28T02:00:00Z"),
		});
		const sql = getTestDb();
		await sql`
      UPDATE public.conversations SET archived_at = now()
      WHERE organization_id = ${org} AND agent_id = ${AGENT}
        AND platform = 'web' AND conversation_id = ${conv}
    `;
		const row = await getConversation({
			organizationId: org,
			agentId: AGENT,
			platform: "web",
			conversationId: conv,
		});
		expect(row).toBeNull();
	});

	it("readConversationReply returns null while the turn is in flight", async () => {
		const reply = await readConversationReply({
			organizationId: org,
			conversationId: "conv-inflight",
			messageId: "msg-inflight",
		});
		expect(reply).toBeNull();
	});

	it("readConversationReply returns the finalText on a completed turn (matched via processedMessageIds)", async () => {
		const conversationId = "conv-complete";
		const messageId = "msg-complete";
		await insertThreadResponse(
			org,
			{
				conversationId,
				processedMessageIds: [messageId],
				finalText: "here is your summary",
			},
			"completed",
		);
		const reply = await readConversationReply({
			organizationId: org,
			conversationId,
			messageId,
		});
		expect(reply).toEqual({ status: "complete", text: "here is your summary" });
	});

	it("readConversationReply matches on the top-level messageId too", async () => {
		const conversationId = "conv-complete-2";
		const messageId = "msg-complete-2";
		await insertThreadResponse(
			org,
			{
				conversationId,
				messageId,
				processedMessageIds: [messageId],
				finalText: "done",
			},
			"completed",
		);
		const reply = await readConversationReply({
			organizationId: org,
			conversationId,
			messageId,
		});
		expect(reply?.status).toBe("complete");
	});

	it("readConversationReply surfaces a terminal error", async () => {
		const conversationId = "conv-error";
		const messageId = "msg-error";
		await insertThreadResponse(
			org,
			{
				conversationId,
				processedMessageIds: [messageId],
				error: "provider unavailable",
			},
			"failed",
		);
		const reply = await readConversationReply({
			organizationId: org,
			conversationId,
			messageId,
		});
		expect(reply).toEqual({ status: "error", error: "provider unavailable" });
	});

	it("readConversationReply does not match a different message's completion", async () => {
		const conversationId = "conv-other";
		await insertThreadResponse(
			org,
			{
				conversationId,
				processedMessageIds: ["some-other-message"],
				finalText: "not for you",
			},
			"completed",
		);
		const reply = await readConversationReply({
			organizationId: org,
			conversationId,
			messageId: "my-message",
		});
		expect(reply).toBeNull();
	});
});
