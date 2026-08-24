import { Chat } from "chat";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import { executeReaction } from "../../../automations/reaction-executor.js";
import { activateWorkspaceEventTask } from "../../../automations/workspace-event.js";
import { getDb } from "../../../db/client.js";
import { InMemoryStateAdapter } from "../../../gateway/__tests__/fixtures/in-memory-state-adapter.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../../gateway/__tests__/helpers/db-setup.js";
import { registerActionHandlers } from "../../../gateway/connections/interaction-bridge.js";
import { gchatPlatform } from "../../../gateway/connections/platforms/gchat.js";
import type { PlatformConnection } from "../../../gateway/connections/types.js";
import {
	invokeTemplateEventAction,
	templateEventActionId,
} from "../../../interactions/template-event-actions.js";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway.js";
import { runtimeConnectionIdToSlug } from "../../../lobu/stores/connections-projection.js";
import { createAutomationRun } from "../../../runs/queue-service.js";
import { registerScheduledJobsTicker } from "../../../scheduled/scheduled-jobs-service.js";
import { manageSchedules } from "../../../tools/admin/manage_schedules.js";
import type { ToolContext } from "../../../tools/registry.js";
import { insertEvent } from "../../../utils/insert-event.js";
import { initWorkspaceProvider } from "../../../workspace/index.js";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures.js";
import { TestApiClient } from "../../setup/test-mcp-client.js";

const mock = vi.fn;

const CONNECTION_ID = "gchat-poll-connection";
const SPACE_NAME = "spaces/AAAA-poll";
const MESSAGE_NAME = `${SPACE_NAME}/messages/poll-card`;
const credentials = JSON.stringify({
	client_email: "lobu-chat@example.iam.gserviceaccount.com",
	private_key: "not-used-by-the-inbound-webhook-test",
	project_id: "lobu-chat-test",
});

/** Tenant Automation configuration: generic SDK calls, no poll code in core. */
const POLL_REACTION = `
export const input = {
  type: "object",
  properties: {
    mode: { enum: ["vote", "deadline"] },
    poll_entity_id: { type: "number" },
    source_event_id: { type: "number" },
    interaction: { type: "object" }
  },
  required: ["mode", "poll_entity_id", "source_event_id"]
};

function rows(result) {
  return Array.isArray(result && result.entities) ? result.entities : [];
}

function actorSlug(platform, actorId) {
  let hash = 2166136261;
  const input = platform + "\\u0000" + actorId;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "poll-response-" + (hash >>> 0).toString(36);
}

export default async (ctx, client) => {
  const input = ctx.extracted_data;
  const pollId = Number(input.poll_entity_id);
  const sourceEventId = Number(input.source_event_id);
  const pollResult = await client.entities.get({ entity_id: pollId });
  const poll = pollResult && pollResult.entity;
  const pollMetadata = poll && poll.metadata ? poll.metadata : {};
  if (pollMetadata.status !== "open") return;

  if (input.mode === "vote") {
    const interaction = input.interaction || {};
    const actor = interaction.actor || {};
    const platform = String(actor.platform || "");
    const actorId = String(actor.id || "");
    const choice = String(interaction.value || "");
    if (!platform || !actorId || !Array.isArray(pollMetadata.options) || !pollMetadata.options.includes(choice)) {
      throw new Error("invalid verified vote event");
    }
    let responses = rows(await client.entities.list({ entity_type: "poll_response", parent_id: pollId, limit: 100 }));
    const current = responses.find((entity) => entity.metadata && entity.metadata.platform === platform && entity.metadata.actor_id === actorId);
    const responseMetadata = {
      poll_id: pollMetadata.poll_id,
      platform,
      actor_id: actorId,
      actor_name: actor.name || null,
      choice,
      updated_at: new Date().toISOString()
    };
    if (current) {
      await client.entities.update({ entity_id: current.id, metadata: responseMetadata });
    } else {
      await client.entities.create({
        type: "poll_response",
        parent_id: pollId,
        slug: actorSlug(platform, actorId),
        name: String(actor.name || actorId),
        metadata: responseMetadata
      });
    }
  }

  const responses = rows(await client.entities.list({ entity_type: "poll_response", parent_id: pollId, limit: 100 }));
  const tally = Object.fromEntries((pollMetadata.options || []).map((option) => [option, 0]));
  for (const response of responses) {
    const choice = response && response.metadata && response.metadata.choice;
    if (Object.prototype.hasOwnProperty.call(tally, choice)) tally[choice] += 1;
  }
  const responseCount = responses.length;
  const quorumReached = Math.max(0, ...Object.values(tally)) >= Number(pollMetadata.quorum || 0);
  const shouldClose = input.mode === "deadline" || quorumReached;
  const materialized = { ...pollMetadata, tally, response_count: responseCount };
  if (!shouldClose) {
    await client.entities.update({ entity_id: pollId, metadata: materialized });
    return;
  }
  const closeReason = input.mode === "deadline" ? "deadline" : "quorum";
  const closed = await client.knowledge.save({
    entity_ids: [pollId],
    content: "Poll closed",
    title: String(poll.name || "Poll") + " — closed",
    semantic_type: "poll_closed",
    payload_type: "empty",
    metadata: { ...materialized, status: "closed", close_reason: closeReason },
    supersedes_event_id: sourceEventId,
    idempotency_key: "poll-close:" + String(pollMetadata.poll_id)
  });
  await client.entities.update({
    entity_id: pollId,
    metadata: {
      ...materialized,
      status: "closed",
      close_reason: closeReason,
      result_delivery_event_id: closed.id
    }
  });
};
`;

function cardClick(params: {
	sourceEventId: number;
	actorId: string;
	actorName: string;
	value: "A" | "B" | "C";
	eventTime: string;
}): Request {
	const space = { name: SPACE_NAME, type: "ROOM", spaceType: "SPACE" };
	const user = {
		name: params.actorId,
		displayName: params.actorName,
		type: "HUMAN",
	};
	return new Request("https://gateway.test/api/v1/webhooks/gchat-poll", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "CARD_CLICKED",
			eventTime: params.eventTime,
			space,
			user,
			message: {
				name: MESSAGE_NAME,
				createTime: "2026-08-24T12:00:00Z",
				sender: { name: "users/lobu", displayName: "Lobu", type: "BOT" },
				space,
			},
			common: { parameters: {} },
			action: {
				actionMethodName: templateEventActionId(params.sourceEventId, "vote"),
				parameters: [{ key: "value", value: params.value }],
			},
		}),
	});
}

async function dispatchAndWait(
	chat: Chat,
	request: Request,
): Promise<Response> {
	const tasks: Promise<unknown>[] = [];
	const response = await chat.webhooks.gchat(request, {
		waitUntil: (task) => tasks.push(task),
	});
	await Promise.all(tasks);
	return response;
}

describe("Google Chat CARD_CLICKED -> declared event -> Postgres", () => {
	beforeAll(async () => {
		await ensureDbForGatewayTests();
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await resetTestDatabase();
	});

	afterEach(() => {
		__setChatInstanceManagerForTests(null);
	});

	test("derives distinct actors, dedupes replay, records changes, and rejects late clicks", async () => {
		const sql = getDb();
		const org = await createTestOrganization({ name: "GChat Poll E2E Org" });
		const owner = await createTestUser({ name: "Poll Owner" });
		await addUserToOrganization(owner.id, org.id, "owner");
		// Production provisions this actor for autonomous entity writes. The
		// isolated integration database starts without global seed users.
		await sql`
      INSERT INTO "user" (id, email, name, username, "emailVerified", "createdAt", "updatedAt")
      VALUES ('system', 'system@lobu.test', 'System', 'system', true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
		const poll = await createTestEntity({
			name: "Release poll",
			entity_type: "poll",
			organization_id: org.id,
			created_by: owner.id,
		});
		const responseTypeSeed = await createTestEntity({
			name: "Response type seed",
			entity_type: "poll_response",
			organization_id: org.id,
			created_by: owner.id,
		});
		await sql`DELETE FROM entities WHERE id = ${responseTypeSeed.id}`;
		const initialPoll = {
			poll_id: "poll-1",
			question: "Ship the release?",
			options: ["A", "B", "C"],
			status: "open",
			quorum: 2,
			closes_at: "2026-08-24T13:00:00Z",
			tally: { A: 0, B: 0, C: 0 },
			response_count: 0,
			connection_id: CONNECTION_ID,
		};
		await sql`
      UPDATE entities SET metadata = ${sql.json(initialPoll)}
      WHERE id = ${poll.id}
    `;
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
							{
								type: "button",
								props: { label: "C", onClick: "@vote", value: "C" },
							},
						],
					},
					interactions: { vote: { emits: "poll_vote_cast" } },
				},
				poll_vote_cast: { description: "A verified vote" },
				poll_closed: {
					description: "A closed poll",
					jsonTemplate: {
						type: "card",
						children: [
							{ type: "text", content: "Poll closed" },
							{ type: "data", path: "tally" },
						],
					},
				},
			})}
      WHERE organization_id = ${org.id}
        AND slug = 'poll'
    `;

		const reducerAgent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: owner.id,
			agentId: "gchat-poll-reducer",
		});
		const api = await TestApiClient.for({
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
		});
		const automation = (await api.automations.create({
			slug: "gchat-poll-reducer",
			name: "Google Chat poll reducer",
			prompt:
				"Materialize verified poll vote events and close at quorum or deadline.",
			agent_id: reducerAgent.agentId,
			triggers: [
				{
					kind: "event",
					source: "workspace",
					entity_type: "poll",
					event_types: ["poll_vote_cast"],
					execution: "window",
					active_run: "queue",
				},
			],
			reaction_script: POLL_REACTION,
		})) as { automation_id: string };
		const automationId = Number(automation.automation_id);
		const [storedAutomation] = await sql<{ reaction_script_compiled: string }>`
      SELECT reaction_script_compiled
      FROM automations
      WHERE id = ${automationId}
    `;
		const compiledReaction = storedAutomation.reaction_script_compiled;

		await sql`
      INSERT INTO connections (
        organization_id, connector_key, agent_id, display_name, status,
        config, credential_mode, slug, visibility
      ) VALUES (
        ${org.id}, 'gchat', ${reducerAgent.agentId}, 'Poll Google Chat', 'active',
        ${sql.json({})}, 'byo', ${runtimeConnectionIdToSlug(CONNECTION_ID)}, 'org'
      )
    `;

		const adapter = await gchatPlatform.createAdapter({
			credentials,
			disableSignatureVerification: true,
			userName: "lobu",
		});
		const postMessage = mock(async (threadId: string) => ({
			id: `${MESSAGE_NAME}-receipt`,
			threadId,
			raw: {},
		}));
		const editMessage = mock(async (threadId: string, messageId: string) => ({
			id: messageId,
			threadId,
			raw: {},
		}));
		(adapter as any).postMessage = postMessage;
		(adapter as any).editMessage = editMessage;
		const editMessageContent = mock(
			async (
				_connectionId: string,
				args: { threadId: string; messageId: string; content: unknown },
			) =>
				(adapter as any).editMessage(
					args.threadId,
					args.messageId,
					args.content,
				),
		);
		__setChatInstanceManagerForTests({ editMessageContent });
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
			payloadData: initialPoll,
			semanticType: "poll_opened",
			metadata: {
				notification_type: "generic",
				delivery: [
					{
						connectionId: CONNECTION_ID,
						channelKey: `gchat:${SPACE_NAME}`,
						messageId: MESSAGE_NAME,
						threadId,
					},
				],
			},
		});

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
					interactionId: `google-${actionEvent.raw.eventTime}`,
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

		const executeConfiguredReducer = async (params: {
			mode: "vote" | "deadline";
			pollEntityId: number;
			sourceEventId: number;
			voteEventId?: number;
		}) => {
			let runId: number;
			let extractedData: Record<string, unknown> = {
				mode: params.mode,
				poll_entity_id: params.pollEntityId,
				source_event_id: params.sourceEventId,
			};
			if (params.mode === "vote") {
				const [task] = await sql<{
					action_input: {
						payload: Parameters<typeof activateWorkspaceEventTask>[0];
					};
				}>`
          SELECT action_input
          FROM runs
          WHERE organization_id = ${org.id}
            AND run_type = 'task'
            AND action_key = 'activate-workspace-event'
            AND action_input->'payload'->>'eventId' = ${String(params.voteEventId)}
          ORDER BY id DESC
          LIMIT 1
        `;
				expect(task).toBeTruthy();
				expect(
					await activateWorkspaceEventTask(task.action_input.payload, sql),
				).toMatchObject({
					matched: 1,
					queued: 1,
				});
				const [run] = await sql<{ id: number }>`
          SELECT id
          FROM runs
          WHERE organization_id = ${org.id}
            AND run_type = 'automation'
            AND automation_id = ${automationId}
            AND approved_input->'trigger_signal'->>'event_id' = ${String(params.voteEventId)}
          ORDER BY id DESC
          LIMIT 1
        `;
				runId = Number(run.id);
				const [vote] = await sql<{ payload_data: Record<string, unknown> }>`
          SELECT payload_data
          FROM events
          WHERE id = ${params.voteEventId as number}
            AND organization_id = ${org.id}
        `;
				// The reducer input comes from the exact durable row, not a caller or
				// model-authored actor field.
				extractedData = { ...extractedData, ...vote.payload_data };
			} else {
				const run = await createAutomationRun(
					{
						organizationId: org.id,
						automationId,
						agentId: reducerAgent.agentId,
						windowStart: "2026-08-24T13:00:00Z",
						windowEnd: "2026-08-24T13:01:00Z",
						dispatchSource: "manual",
					},
					sql,
				);
				runId = run.runId;
			}
			const reduced = await executeReaction({
				compiledScript: compiledReaction,
				context: {
					extracted_data: extractedData,
					entities: [],
					window: {
						run_id: runId,
						automation_id: automationId,
						window_start: "2026-08-24T12:00:00Z",
						window_end: "2026-08-24T14:00:00Z",
						granularity: "day",
						content_analyzed: params.mode === "vote" ? 1 : 0,
					},
					automation: {
						id: automationId,
						slug: "gchat-poll-reducer",
						name: "Google Chat poll reducer",
						version: 1,
					},
					organization_id: org.id,
					organization_slug: org.slug,
				},
				env: process.env as Record<string, string | undefined>,
			});
			expect(reduced).toEqual({ success: true });
		};

		const adaA = cardClick({
			sourceEventId: source.id,
			actorId: "users/ada",
			actorName: "Ada",
			value: "A",
			eventTime: "2026-08-24T12:01:00Z",
		});
		expect((await dispatchAndWait(chat, adaA.clone())).status).toBe(200);
		const [adaVote] = await sql<{ id: number }>`
      SELECT id FROM events
      WHERE organization_id = ${org.id} AND semantic_type = 'poll_vote_cast'
      ORDER BY id DESC LIMIT 1
    `;
		await executeConfiguredReducer({
			mode: "vote",
			pollEntityId: poll.id,
			sourceEventId: source.id,
			voteEventId: Number(adaVote.id),
		});
		const afterAda = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${poll.id}
    `;
		expect(afterAda[0].metadata).toMatchObject({
			status: "open",
			tally: { A: 1, B: 0, C: 0 },
			response_count: 1,
		});
		// The exact Google delivery is retried: the durable idempotency key wins.
		expect((await dispatchAndWait(chat, adaA.clone())).status).toBe(200);
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${org.id} AND semantic_type = 'poll_vote_cast'
      `,
		).toHaveLength(1);
		expect(
			(
				await dispatchAndWait(
					chat,
					cardClick({
						sourceEventId: source.id,
						actorId: "users/grace",
						actorName: "Grace",
						value: "B",
						eventTime: "2026-08-24T12:01:01Z",
					}),
				)
			).status,
		).toBe(200);
		const [graceVote] = await sql<{ id: number }>`
      SELECT id FROM events
      WHERE organization_id = ${org.id} AND semantic_type = 'poll_vote_cast'
      ORDER BY id DESC LIMIT 1
    `;
		await executeConfiguredReducer({
			mode: "vote",
			pollEntityId: poll.id,
			sourceEventId: source.id,
			voteEventId: Number(graceVote.id),
		});
		const afterGrace = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${poll.id}
    `;
		expect(afterGrace[0].metadata).toMatchObject({
			status: "open",
			tally: { A: 1, B: 1, C: 0 },
			response_count: 2,
		});
		// A later click by Ada is a new immutable vote-change event.
		expect(
			(
				await dispatchAndWait(
					chat,
					cardClick({
						sourceEventId: source.id,
						actorId: "users/ada",
						actorName: "Ada",
						value: "B",
						eventTime: "2026-08-24T12:01:02Z",
					}),
				)
			).status,
		).toBe(200);
		const [adaChange] = await sql<{ id: number }>`
      SELECT id FROM events
      WHERE organization_id = ${org.id} AND semantic_type = 'poll_vote_cast'
      ORDER BY id DESC LIMIT 1
    `;
		await executeConfiguredReducer({
			mode: "vote",
			pollEntityId: poll.id,
			sourceEventId: source.id,
			voteEventId: Number(adaChange.id),
		});

		const votes = await sql<{
			payload_data: { interaction: { value: string; actor: { id: string } } };
		}>`
      SELECT payload_data
      FROM events
      WHERE organization_id = ${org.id}
        AND semantic_type = 'poll_vote_cast'
      ORDER BY id
    `;
		expect(votes.map((row) => row.payload_data.interaction)).toEqual([
			expect.objectContaining({
				value: "A",
				actor: expect.objectContaining({ id: "users/ada" }),
			}),
			expect.objectContaining({
				value: "B",
				actor: expect.objectContaining({ id: "users/grace" }),
			}),
			expect.objectContaining({
				value: "B",
				actor: expect.objectContaining({ id: "users/ada" }),
			}),
		]);
		const responses = await sql<{
			metadata: { actor_id: string; choice: string };
		}>`
      SELECT e.metadata
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id}
        AND e.parent_id = ${poll.id}
        AND et.slug = 'poll_response'
        AND e.deleted_at IS NULL
      ORDER BY e.metadata->>'actor_id'
    `;
		expect(responses).toHaveLength(2);
		expect(responses.map((response) => response.metadata)).toMatchObject([
			{ actor_id: "users/ada", choice: "B" },
			{ actor_id: "users/grace", choice: "B" },
		]);
		const [closedPoll] = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${poll.id}
    `;
		expect(closedPoll.metadata).toMatchObject({
			status: "closed",
			close_reason: "quorum",
			tally: { A: 0, B: 2, C: 0 },
			response_count: 2,
			result_delivery_event_id: expect.any(Number),
		});
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${org.id} AND semantic_type = 'poll_closed'
      `,
		).toHaveLength(1);
		expect(editMessageContent).toHaveBeenCalledTimes(1);
		expect(
			(
				await dispatchAndWait(
					chat,
					cardClick({
						sourceEventId: source.id,
						actorId: "users/linus",
						actorName: "Linus",
						value: "A",
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
		).toHaveLength(3);
		expect(JSON.stringify(postMessage.mock.calls)).toContain(
			"This interaction is closed or has been replaced.",
		);

		// A deadline wake against the already quorum-closed poll is a semantic no-op.
		await executeConfiguredReducer({
			mode: "deadline",
			pollEntityId: poll.id,
			sourceEventId: source.id,
		});
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${org.id} AND semantic_type = 'poll_closed'
      `,
		).toHaveLength(1);
		expect(editMessageContent).toHaveBeenCalledTimes(1);

		const deadlinePoll = await createTestEntity({
			name: "Deadline poll",
			entity_type: "poll",
			organization_id: org.id,
			created_by: owner.id,
		});
		const deadlineMetadata = {
			...initialPoll,
			poll_id: "poll-2",
			question: "Wait for another review?",
			closes_at: "2026-08-24T13:00:00Z",
		};
		await sql`
      UPDATE entities SET metadata = ${sql.json(deadlineMetadata)}
      WHERE id = ${deadlinePoll.id}
    `;
		const deadlineMessageId = `${MESSAGE_NAME}-deadline`;
		const deadlineThreadId = (adapter as any).encodeThreadId({
			spaceName: SPACE_NAME,
			threadName: deadlineMessageId,
		});
		const deadlineSource = await insertEvent({
			entityIds: [deadlinePoll.id],
			organizationId: org.id,
			originId: "gchat-poll-deadline-opened",
			title: "Wait for another review?",
			payloadType: "empty",
			payloadData: deadlineMetadata,
			semanticType: "poll_opened",
			metadata: {
				notification_type: "generic",
				delivery: [
					{
						connectionId: CONNECTION_ID,
						channelKey: `gchat:${SPACE_NAME}`,
						messageId: deadlineMessageId,
						threadId: deadlineThreadId,
					},
				],
			},
		});

		const scheduleCtx: ToolContext = {
			organizationId: org.id,
			userId: owner.id,
			memberRole: "owner",
			agentId: reducerAgent.agentId,
			isAuthenticated: true,
			clientId: "gchat-poll-e2e",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "pat",
			scopedToOrg: true,
			allowCrossOrg: false,
			sourceContext: {
				platform: "gchat",
				connectionId: CONNECTION_ID,
				channelId: SPACE_NAME,
				conversationId: deadlineThreadId,
				userId: owner.id,
			},
		};
		const scheduleArgs = {
			action: "create" as const,
			description: "Close poll-2 at its deadline",
			run_at: new Date(Date.now() - 60_000).toISOString(),
			idempotency_key: "poll-deadline:poll-2",
			payload: {
				type: "wake_agent" as const,
				agent_id: reducerAgent.agentId,
				prompt: `Close poll ${deadlinePoll.id} from source event ${deadlineSource.id}.`,
			},
		};
		const scheduled = await manageSchedules(
			scheduleArgs,
			{} as never,
			scheduleCtx,
		);
		const replayedSchedule = await manageSchedules(
			scheduleArgs,
			{} as never,
			scheduleCtx,
		);
		expect(replayedSchedule.schedule?.id).toBe(scheduled.schedule?.id);
		expect(
			await sql`
        SELECT id FROM scheduled_jobs
        WHERE organization_id = ${org.id}
          AND idempotency_key = 'poll-deadline:poll-2'
      `,
		).toHaveLength(1);

		const spawned: Array<{ name: string; payload: Record<string, unknown> }> =
			[];
		const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
		registerScheduledJobsTicker({
			register: (name: string, handler: (ctx: unknown) => Promise<void>) =>
				handlers.set(name, handler),
			spawn: async (name: string, payload: Record<string, unknown>) => {
				spawned.push({ name, payload });
				return "spawned";
			},
		} as never);
		await handlers.get("scheduled-jobs-tick")?.({});
		expect(spawned).toHaveLength(1);
		expect(spawned[0]).toMatchObject({
			name: "wake_agent",
			payload: {
				agent_id: reducerAgent.agentId,
				__organization_id: org.id,
				__delivery_context: {
					platform: "gchat",
					connectionId: CONNECTION_ID,
					channelId: SPACE_NAME,
				},
			},
		});
		await executeConfiguredReducer({
			mode: "deadline",
			pollEntityId: deadlinePoll.id,
			sourceEventId: deadlineSource.id,
		});
		const [deadlineClosed] = await sql<{ metadata: Record<string, unknown> }>`
      SELECT metadata FROM entities WHERE id = ${deadlinePoll.id}
    `;
		expect(deadlineClosed.metadata).toMatchObject({
			status: "closed",
			close_reason: "deadline",
			tally: { A: 0, B: 0, C: 0 },
			response_count: 0,
			result_delivery_event_id: expect.any(Number),
		});
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${org.id} AND semantic_type = 'poll_closed'
      `,
		).toHaveLength(2);
		expect(editMessageContent).toHaveBeenCalledTimes(2);
		const [job] = await sql<{ paused: boolean; last_fired_at: Date | null }>`
      SELECT paused, last_fired_at FROM scheduled_jobs
      WHERE id = ${scheduled.schedule?.id as string}
    `;
		expect(job.paused).toBe(true);
		expect(job.last_fired_at).toBeTruthy();
	});
});
