import { Chat } from "chat";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { getDb } from "../../../db/client.js";
import { InMemoryStateAdapter } from "../../../gateway/__tests__/fixtures/in-memory-state-adapter.js";
import {
	interactionDeliveryId,
	registerActionHandlers,
} from "../../../gateway/connections/interaction-bridge.js";
import { gchatPlatform } from "../../../gateway/connections/platforms/gchat.js";
import type { PlatformConnection } from "../../../gateway/connections/types.js";
import {
	invokeTemplateEventAction,
	templateEventActionId,
} from "../../../interactions/template-event-actions.js";
import { resolveNotificationKindCard } from "../../../notifications/service.js";
import { insertEvent } from "../../../utils/insert-event.js";
import { initWorkspaceProvider } from "../../../workspace/index.js";
import { cleanupTestDatabase } from "../../setup/test-db.js";
import {
	addUserToOrganization,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures.js";

const CONNECTION_ID = "gchat-poll-connection";
const SPACE_NAME = "spaces/AAAA-poll";
const MESSAGE_NAME = `${SPACE_NAME}/messages/poll-card`;

function cardClick(params: {
	actionId: string;
	actorId: string;
	actorName: string;
	value: "A" | "B";
	eventTime: string;
}): Request {
	const space = { name: SPACE_NAME, type: "ROOM", spaceType: "SPACE" };
	return new Request("https://gateway.test/api/v1/webhooks/gchat-poll", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "CARD_CLICKED",
			eventTime: params.eventTime,
			space,
			user: {
				name: params.actorId,
				displayName: params.actorName,
				type: "HUMAN",
			},
			message: {
				name: MESSAGE_NAME,
				createTime: "2026-08-24T12:00:00Z",
				sender: { name: "users/lobu", displayName: "Lobu", type: "BOT" },
				space,
			},
			common: { parameters: {} },
			action: {
				actionMethodName: params.actionId,
				parameters: [{ key: "value", value: params.value }],
			},
		}),
	});
}

async function dispatchAndWait(chat: Chat, request: Request): Promise<Response> {
	const tasks: Promise<unknown>[] = [];
	const response = await chat.webhooks.gchat(request, {
		waitUntil: (task) => tasks.push(task),
	});
	await Promise.all(tasks);
	return response;
}

describe("Google Chat declared event action adapter", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	test("routes a native card click to one actor-bound event and rejects a stale card", async () => {
		const sql = getDb();
		const org = await createTestOrganization({ name: "GChat Action Org" });
		const owner = await createTestUser({ name: "Poll Owner" });
		await addUserToOrganization(owner.id, org.id, "owner");
		const poll = await createTestEntity({
			name: "Release poll",
			entity_type: "poll",
			organization_id: org.id,
			created_by: owner.id,
		});
		const pollData = {
			poll_id: "poll-1",
			question: "Ship the release?",
			options: ["A", "B"],
			status: "open",
		};
		await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json({
				poll_opened: {
					description: "An open poll",
					jsonTemplate: {
						type: "card",
						children: [
							{
								type: "button",
								props: { label: "A", onClick: "@vote", value: "A" },
							},
							{
								type: "button",
								props: { label: "B", onClick: "@vote", value: "B" },
							},
						],
					},
					interactions: { vote: { emits: "poll_vote_cast" } },
				},
				poll_vote_cast: { description: "A verified vote" },
				poll_closed: {
					description: "A closed poll",
					jsonTemplate: { type: "text", content: "Poll closed" },
				},
			})}
      WHERE organization_id = ${org.id}
        AND slug = 'poll'
    `;

		const adapter = await gchatPlatform.createAdapter({
			credentials: JSON.stringify({
				client_email: "lobu-chat@example.iam.gserviceaccount.com",
				private_key: "not-used-by-the-inbound-webhook-test",
				project_id: "lobu-chat-test",
			}),
			disableSignatureVerification: true,
			userName: "lobu",
		});
		const postMessage = vi.fn(async (threadId: string) => ({
			id: `${MESSAGE_NAME}-receipt`,
			threadId,
			raw: {},
		}));
		(adapter as any).postMessage = postMessage;
		const chat = new Chat({
			userName: "lobu",
			adapters: { gchat: adapter },
			state: new InMemoryStateAdapter(),
		});
		const threadId = (adapter as any).encodeThreadId({
			spaceName: SPACE_NAME,
			threadName: MESSAGE_NAME,
		});
		const source = await insertEvent({
			entityIds: [poll.id],
			organizationId: org.id,
			originId: "gchat-poll-opened",
			title: "Ship the release?",
			payloadType: "empty",
			payloadData: pollData,
			semanticType: "poll_opened",
			metadata: {
				notification_type: "generic",
				delivery: [
					{
						connectionId: CONNECTION_ID,
						messageId: MESSAGE_NAME,
						threadId,
					},
				],
			},
		});
		const actionId = templateEventActionId(source.id, "vote");
		const card = await resolveNotificationKindCard(
			{
				organizationId: org.id,
				type: "agent_message",
				title: "Ship the release?",
				semanticType: "poll_opened",
				entityIds: [poll.id],
				payloadData: pollData,
			},
			source.id,
		);
		expect(JSON.stringify(card)).toContain(actionId);

		registerActionHandlers(
			chat as any,
			{
				id: CONNECTION_ID,
				platform: "gchat",
				organizationId: org.id,
			} as PlatformConnection,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			async (sourceEventId, action, value, actionEvent) =>
				invokeTemplateEventAction({
					organizationId: org.id,
					sourceEventId,
					action,
					value,
					interactionId: interactionDeliveryId(actionEvent),
					surface: "gchat",
					actor: {
						platform: "gchat",
						platformUserId: actionEvent.user.userId,
						name: actionEvent.user.fullName,
					},
					source: {
						connectionId: CONNECTION_ID,
						messageId: actionEvent.messageId,
						threadId: actionEvent.threadId,
					},
				}),
		);

		const adaClick = cardClick({
			actionId,
			actorId: "users/ada",
			actorName: "Ada",
			value: "A",
			eventTime: "2026-08-24T12:01:00Z",
		});
		expect((await dispatchAndWait(chat, adaClick.clone())).status).toBe(200);
		expect((await dispatchAndWait(chat, adaClick.clone())).status).toBe(200);

		const votes = await sql<{
			created_by: string | null;
			metadata: { interaction: { value: string; actor: { id: string } } };
		}>`
      SELECT created_by, metadata
      FROM events
      WHERE organization_id = ${org.id}
        AND semantic_type = 'poll_vote_cast'
      ORDER BY id
    `;
		expect(votes).toHaveLength(1);
		expect(votes[0]).toMatchObject({
			created_by: null,
			metadata: {
				interaction: { value: "A", actor: { id: "users/ada" } },
			},
		});
		expect(postMessage).toHaveBeenCalledTimes(1);

		await insertEvent({
			entityIds: [poll.id],
			organizationId: org.id,
			originId: "gchat-poll-closed",
			semanticType: "poll_closed",
			payloadType: "empty",
			metadata: { ...pollData, status: "closed" },
			supersedesEventId: source.id,
		});
		expect(
			(
				await dispatchAndWait(
					chat,
					cardClick({
						actionId,
						actorId: "users/grace",
						actorName: "Grace",
						value: "B",
						eventTime: "2026-08-24T12:02:00Z",
					}),
				)
			).status,
		).toBe(200);
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${org.id}
          AND semantic_type = 'poll_vote_cast'
      `,
		).toHaveLength(1);
		expect(JSON.stringify(postMessage.mock.calls)).toContain(
			"This interaction is closed or has been replaced.",
		);
	});
});
