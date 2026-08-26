import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { invokeTemplateEventAction } from "../../../interactions/template-event-actions";
import {
	assertTemplateActionCapability,
	TEMPLATE_ACTION_CAPABILITY_META_KEY,
} from "../../../interactions/template-action-capability";
import { __setChatInstanceManagerForTests } from "../../../lobu/gateway";
import { getContent } from "../../../tools/get_content";
import { getMcpResultMeta } from "../../../tools/mcp-result-meta";
import type { ToolContext } from "../../../tools/registry";
import { insertEvent } from "../../../utils/insert-event";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestAgent, createTestEntity } from "../../setup/test-fixtures";
import { TestApiClient, TestWorkspace } from "../../setup/test-mcp-client";

describe("template event actions", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	afterEach(() => {
		__setChatInstanceManagerForTests(null);
	});

	it("binds actor + delivery, dedupes retries, and wakes subscribed Automations", async () => {
		const sql = getTestDb();
		const workspace = await TestWorkspace.create({
			name: "Template Action Org",
		});
		const ownerUserId = workspace.users.owner.id;
		const poll = await createTestEntity({
			name: "Deployment poll",
			entity_type: "poll",
			organization_id: workspace.org.id,
			created_by: ownerUserId,
		});
		const eventKinds = {
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
			poll_vote_cast: { description: "A verified vote interaction" },
			poll_closed: {
				description: "A closed poll",
				jsonTemplate: {
					type: "card",
					children: [
						{ type: "text", content: "Poll closed" },
						{
							type: "button",
							props: { label: "Reopen", onClick: "@reopen" },
						},
					],
				},
				interactions: { reopen: { emits: "poll_reopen_requested" } },
			},
			poll_reopen_requested: { description: "A verified reopen request" },
		};
		await sql`
      UPDATE entity_types
      SET event_kinds = ${sql.json(eventKinds)}
      WHERE organization_id = ${workspace.org.id}
        AND slug = 'poll'
    `;

		const agent = await createTestAgent({
			organizationId: workspace.org.id,
			ownerUserId,
			agentId: "poll-reducer",
		});
		const api = await TestApiClient.for({
			organizationId: workspace.org.id,
			userId: ownerUserId,
			memberRole: "owner",
		});
		await api.automations.create({
			slug: "poll-vote-reducer",
			prompt: "Reduce the verified vote event.",
			agent_id: agent.agentId,
			triggers: [
				{
					kind: "event",
					source: "workspace",
					event_types: ["poll_vote_cast"],
					execution: "window",
					active_run: "queue",
				},
			],
		});

		const source = await insertEvent({
			entityIds: [poll.id],
			organizationId: workspace.org.id,
			originId: "poll-opened-1",
			title: "Ship this release?",
			content: "Choose the release outcome.",
			payloadType: "empty",
			payloadData: { poll_id: "poll-1", quorum: 2 },
			semanticType: "poll_opened",
			metadata: {
				notification_type: "generic",
				resource_url: "https://app.lobu.ai/template-action-poll",
				delivery: [
					{
						connectionId: "91",
						channelKey: "gchat:spaces/AAA",
						messageId: "spaces/AAA/messages/poll-1",
						threadId: "gchat:spaces/AAA:threads/thread-1",
					},
				],
			},
		});
		const mcpAppCtx = {
			organizationId: workspace.org.id,
			userId: ownerUserId,
			memberRole: "owner",
			isAuthenticated: true,
			clientId: "poll-mcp-app",
			mcpSessionId: "poll-mcp-session",
			mcpConversationId: "poll-mcp-conversation",
			tokenType: "oauth",
			scopes: ["mcp:read", "mcp:write"],
			scopedToOrg: true,
			allowCrossOrg: false,
		} as ToolContext & {
			userId: string;
			clientId: string;
			mcpSessionId: string;
		};
		const rendered = await getContent(
			{ content_ids: [source.id], limit: 10 },
			{} as never,
			mcpAppCtx,
		);
		const capability = getMcpResultMeta(rendered)?.[
			TEMPLATE_ACTION_CAPABILITY_META_KEY
		];
		expect(typeof capability).toBe("string");
		expect(() =>
			assertTemplateActionCapability(
				capability as string,
				source.id,
				mcpAppCtx,
			),
		).not.toThrow();

		const invoke = (overrides: Record<string, unknown> = {}) =>
			invokeTemplateEventAction({
				organizationId: workspace.org.id,
				sourceEventId: source.id,
				action: "vote",
				value: "A",
				interactionId: "google-event-1",
				surface: "gchat",
				actor: {
					platform: "gchat",
					platformUserId: "users/ada",
					name: "Ada",
				},
				source: {
					connectionId: "91",
					messageId: "spaces/AAA/messages/poll-1",
					threadId: "gchat:spaces/AAA:threads/thread-1",
				},
				...overrides,
			} as never);

		const first = await invoke();
		expect(first).toMatchObject({ created: true, eventType: "poll_vote_cast" });
		const replay = await invoke();
		expect(replay).toEqual({ ...first, created: false });

		const votes = await sql<{
			id: number;
			metadata: {
				poll_id: string;
				interaction: { value: string; actor: { id: string } };
			};
		}>`
      SELECT id, metadata
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND semantic_type = 'poll_vote_cast'
      ORDER BY id
    `;
		expect(votes).toHaveLength(1);
		expect(votes[0].metadata).toMatchObject({
			poll_id: "poll-1",
			interaction: { value: "A", actor: { id: "users/ada" } },
		});

		const activations = await sql`
      SELECT id
      FROM runs
      WHERE organization_id = ${workspace.org.id}
        AND run_type = 'task'
        AND action_key = 'activate-workspace-event'
    `;
		expect(activations).toHaveLength(1);

		await expect(
			invoke({ value: "C", interactionId: "forged-value" }),
		).rejects.toThrow(/not present in the rendered event/i);
		await api.knowledge.save({
			entity_ids: [poll.id],
			content: "Poisoned retry key",
			semantic_type: "poll_opened",
			payload_type: "empty",
			metadata: { status: "still-open" },
			idempotency_key: `event-action:${source.id}:gchat:poisoned-click`,
		});
		await expect(
			invoke({ interactionId: "poisoned-click" }),
		).rejects.toThrow();
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${workspace.org.id}
          AND semantic_type = 'poll_vote_cast'
      `,
		).toHaveLength(1);
		await expect(
			invoke({ action: "close", interactionId: "forged-action" }),
		).rejects.toThrow(/does not declare/i);
		await expect(
			invoke({
				interactionId: "wrong-connection",
				source: {
					connectionId: "92",
					messageId: "spaces/AAA/messages/poll-1",
				},
			}),
		).rejects.toThrow(/does not belong to this chat delivery/i);

		const otherWorkspace = await TestWorkspace.create({
			name: "Other Template Action Org",
		});
		await expect(
			invoke({
				organizationId: otherWorkspace.org.id,
				interactionId: "wrong-org",
			}),
		).rejects.toThrow(/not found/i);

		const editMessageContent = vi.fn(async () => undefined);
		__setChatInstanceManagerForTests({ editMessageContent });
		await api.knowledge.save({
			entity_ids: [poll.id],
			content: "Closed after quorum was reached.",
			semantic_type: "poll_closed",
			title: "Ship this release? Closed",
			payload_type: "empty",
			metadata: { poll_id: "poll-1", status: "closed" },
			supersedes_event_id: source.id,
			idempotency_key: "poll-close:poll-1",
		});
		await vi.waitFor(() =>
			expect(editMessageContent).toHaveBeenCalledTimes(1),
		);
		expect(editMessageContent).toHaveBeenCalledWith("91", {
			threadId: "gchat:spaces/AAA:threads/thread-1",
			messageId: "spaces/AAA/messages/poll-1",
			content: expect.objectContaining({ card: expect.anything() }),
		});
		const refreshedCard = JSON.stringify(
			editMessageContent.mock.calls[0]?.[1]?.content,
		);
		expect(refreshedCard).toContain("Closed after quorum was reached.");
		expect(refreshedCard).toContain("Open in Lobu");
		expect(refreshedCard).toContain("/template-action-poll");
		const [closed] = await sql<{
			id: number;
			metadata: { delivery?: unknown };
		}>`
      SELECT id, metadata
      FROM events
      WHERE organization_id = ${workspace.org.id}
        AND semantic_type = 'poll_closed'
      ORDER BY id DESC
		LIMIT 1
    `;
		if (!closed) throw new Error("Expected a poll_closed replacement event");
		await vi.waitFor(async () => {
			const [refreshed] = await sql<{ metadata: { delivery?: unknown } }>`
        SELECT metadata
        FROM events
        WHERE id = ${closed.id}
      `;
			expect(refreshed.metadata.delivery).toEqual([
				{
					connectionId: "91",
					channelKey: "gchat:spaces/AAA",
					messageId: "spaces/AAA/messages/poll-1",
					threadId: "gchat:spaces/AAA:threads/thread-1",
				},
			]);
		});
		await expect(
			invokeTemplateEventAction({
				organizationId: workspace.org.id,
				sourceEventId: closed.id,
				action: "reopen",
				value: null,
				interactionId: "google-reopen-1",
				surface: "gchat",
				actor: {
					platform: "gchat",
					platformUserId: "users/ada",
					name: "Ada",
				},
				source: {
					connectionId: "91",
					messageId: "spaces/AAA/messages/poll-1",
					threadId: "gchat:spaces/AAA:threads/thread-1",
				},
			}),
		).resolves.toMatchObject({
			created: true,
			eventType: "poll_reopen_requested",
		});
		await expect(invoke({ interactionId: "late-click" })).rejects.toThrow(
			/closed|replaced/i,
		);
		expect(
			await sql`
        SELECT id FROM events
        WHERE organization_id = ${workspace.org.id}
          AND semantic_type = 'poll_vote_cast'
      `,
		).toHaveLength(1);
	});
});
