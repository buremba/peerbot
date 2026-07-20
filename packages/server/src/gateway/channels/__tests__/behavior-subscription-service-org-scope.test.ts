import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { listTestBehaviorSubscriptions } from "../../../__tests__/setup/behavior-subscriptions.js";
import {
	addUserToOrganization,
	createTestUser,
} from "../../../__tests__/setup/test-fixtures.js";
import { getDb } from "../../../db/client.js";
import { softDeleteChatConnectionProjection } from "../../../lobu/stores/connections-projection.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../__tests__/helpers/db-setup.js";
import { BehaviorSubscriptionService } from "../behavior-subscription-service.js";

describe("BehaviorSubscriptionService connection-scoped routing", () => {
	const ORG_A = "org-a";
	const ORG_B = "org-b";
	const CHANNEL = "slack:C123";
	let connectionA: number;
	let connectionA2: number;
	let previewConnection: number;

	beforeAll(async () => {
		await ensureDbForGatewayTests();
	});

	beforeEach(async () => {
		await resetTestDatabase();
		await seedAgentRow("agent-a", { organizationId: ORG_A });
		await seedAgentRow("agent-a2", { organizationId: ORG_A });
		await seedAgentRow("agent-b", { organizationId: ORG_B });
		const userA = await createTestUser();
		const userB = await createTestUser();
		await addUserToOrganization(userA.id, ORG_A, "owner");
		await addUserToOrganization(userB.id, ORG_B, "owner");
		const sql = getDb();
		const rows = await sql`
      INSERT INTO connections (
        organization_id, connector_key, slug, display_name, status,
        credential_mode, config
      ) VALUES
        (${ORG_A}, 'slack', 'agentconn-a', 'Slack A', 'active', 'byo', '{}'),
        (${ORG_A}, 'slack', 'agentconn-a2', 'Slack A2', 'active', 'byo', '{}'),
        (${ORG_B}, 'slack', 'agentconn-preview', 'Preview', 'active', 'managed', '{}')
      RETURNING id, slug
    `;
		connectionA = Number(rows.find((row) => row.slug === "agentconn-a")?.id);
		connectionA2 = Number(rows.find((row) => row.slug === "agentconn-a2")?.id);
		previewConnection = Number(
			rows.find((row) => row.slug === "agentconn-preview")?.id,
		);
	});

	afterAll(async () => {
		await resetTestDatabase();
	});

	test("two bot connections in one workspace can bind the same channel independently", async () => {
		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
		});
		await svc.createChatBehavior("agent-a2", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA2,
		});

		expect((await svc.resolveForConnection("a", CHANNEL, ORG_A))?.agentId).toBe(
			"agent-a",
		);
		expect(
			(await svc.resolveForConnection("a2", CHANNEL, ORG_A))?.agentId,
		).toBe("agent-a2");

		const rows = await listTestBehaviorSubscriptions({
			organizationId: ORG_A,
			channelId: CHANNEL,
		});
		expect(rows).toHaveLength(2);
	});

	test("relinks and archives a chat Behavior without a bindings table", async () => {
		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
			model: "openai/gpt-5",
		});
		expect((await svc.resolveForConnection("a", CHANNEL, ORG_A))?.agentId).toBe(
			"agent-a",
		);

		await svc.createChatBehavior("agent-a2", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
			model: "anthropic/claude-sonnet",
		});
		const relinked = await svc.resolveForConnection("a", CHANNEL, ORG_A);
		expect(relinked?.agentId).toBe("agent-a2");
		expect(relinked?.model).toBe("anthropic/claude-sonnet");
		expect(await svc.listChatBehaviors("agent-a2", ORG_A)).toHaveLength(1);
		expect(
			await svc.archiveChatBehavior("agent-a2", CHANNEL, connectionA, ORG_A),
		).toBe(true);
		expect(await svc.resolveForConnection("a", CHANNEL, ORG_A)).toBeNull();
	});

	test("prefers system:chat-link over a newer non-link message Behavior", async () => {
		// Slash/button routing takes LIMIT 1. A digest Behavior that also matches
		// message.created on the same channel must not steal the chat-link agent
		// just because it was updated more recently.
		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
		});
		const sql = getDb();
		const member = await sql<{ userId: string }>`
			SELECT "userId" FROM member
			WHERE "organizationId" = ${ORG_A}
			ORDER BY "createdAt"
			LIMIT 1
		`;
		const createdBy = member[0]?.userId;
		if (!createdBy) throw new Error("Expected an organization member");
		const digestId = 9001;
		await sql`
			INSERT INTO watchers (
				id, name, slug, description, organization_id, entity_ids,
				schedule, next_run_at, triggers, agent_id, model_config,
				execution_config, sources, version, current_version_id, tags,
				status, created_by, created_at, updated_at, watcher_group_id
			) VALUES (
				${digestId}, 'Channel digest', 'channel-digest',
				'Background digest', ${ORG_A}, '{}'::bigint[],
				NULL, NULL,
				${sql.json([
					{
						kind: "event",
						connector_key: "slack",
						connection_id: connectionA,
						event_types: ["message.created"],
						match: { channel_id: "C123", team_id: "T1" },
						execution: "turn",
						active_run: "queue",
						output: "none",
						skip_if_unchanged: false,
					},
				])},
				'agent-a2', '{}'::jsonb, NULL, '[]'::jsonb, 1, NULL,
				ARRAY['digest']::text[], 'active', ${createdBy},
				current_timestamp, current_timestamp + interval '1 hour',
				${digestId}
			)
		`;

		const resolved = await svc.resolveForConnection("a", CHANNEL, ORG_A);
		expect(resolved?.agentId).toBe("agent-a");
	});

	test("serializes concurrent createChatBehavior writes into one Behavior", async () => {
		const svc = new BehaviorSubscriptionService();
		await Promise.all([
			svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
				organizationId: ORG_A,
				connectionId: connectionA,
			}),
			svc.createChatBehavior("agent-a2", "slack", CHANNEL, "T1", {
				organizationId: ORG_A,
				connectionId: connectionA,
			}),
		]);

		const rows = (
			await listTestBehaviorSubscriptions({
				organizationId: ORG_A,
				channelId: CHANNEL,
			})
		).filter((row) => Number(row.connection_id) === connectionA);
		expect(rows).toHaveLength(1);
		const agentId = (await svc.resolveForConnection("a", CHANNEL, ORG_A))
			?.agentId;
		expect(["agent-a", "agent-a2"]).toContain(agentId);
	});

	test("archives the Behavior when its connection is soft-deleted", async () => {
		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
		});
		const sql = getDb();

		await softDeleteChatConnectionProjection(sql, ORG_A, "a");

		const [behavior] = await sql<{ status: string }>`
			SELECT status
			FROM watchers
			WHERE organization_id = ${ORG_A}
			  AND tags @> ARRAY['system:chat-link']::text[]
		`;
		expect(behavior.status).toBe("archived");
		const [connection] = await sql<{ deleted_at: Date | null }>`
			SELECT deleted_at FROM connections WHERE id = ${connectionA}
		`;
		expect(connection.deleted_at).toBeInstanceOf(Date);
	});

	test("re-linking one connection updates only that connection's agent", async () => {
		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
		});
		await svc.createChatBehavior("agent-a2", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
		});

		expect((await svc.resolveForConnection("a", CHANNEL, ORG_A))?.agentId).toBe(
			"agent-a2",
		);
		const rows = (
			await listTestBehaviorSubscriptions({
				organizationId: ORG_A,
				channelId: CHANNEL,
			})
		).filter((row) => Number(row.connection_id) === connectionA);
		expect(rows).toHaveLength(1);
	});

	test("preview routing can resolve a binding owned by another org", async () => {
		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: previewConnection,
		});

		expect(
			await svc.resolveForConnection("preview", CHANNEL, ORG_B),
		).toBeNull();
		const binding = await svc.resolveForConnection(
			"preview",
			CHANNEL,
			ORG_B,
			true,
		);
		expect(binding?.agentId).toBe("agent-a");
		expect(binding?.organizationId).toBe(ORG_A);
	});

	test("attributes a chat Behavior to the explicit configuring member", async () => {
		const additionalUser = await createTestUser();
		await addUserToOrganization(additionalUser.id, ORG_A, "member");
		const sql = getDb();
		const members = await sql<{ id: string }>`
			SELECT u.id
			FROM member m
			JOIN "user" u ON u.id = m."userId"
			WHERE m."organizationId" = ${ORG_A}
			ORDER BY u.id DESC
		`;
		const configuredBy = members[0]?.id;
		if (!configuredBy) throw new Error("Expected an organization member");

		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
			configuredBy,
		});

		const [behavior] = await sql<{ created_by: string }>`
			SELECT created_by
			FROM watchers
			WHERE organization_id = ${ORG_A}
			  AND tags @> ARRAY['system:chat-link']::text[]
			LIMIT 1
		`;
		expect(behavior.created_by).toBe(configuredBy);
	});

	test("allocates chat Behavior IDs after canonical Behavior writes", async () => {
		const sql = getDb();
		await sql`
			INSERT INTO watchers (
				id, name, slug, organization_id, agent_id, created_by,
				watcher_group_id
			)
			SELECT 1, 'Existing Behavior', 'existing-behavior', ${ORG_A},
				'agent-a', m."userId", 1
			FROM member m
			WHERE m."organizationId" = ${ORG_A}
			ORDER BY m."createdAt"
			LIMIT 1
		`;
		await sql`
			INSERT INTO watcher_versions (
				id, watcher_id, version, name, prompt, created_by
			)
			SELECT 1, 1, 1, 'Existing Behavior', 'Already persisted.', m."userId"
			FROM member m
			WHERE m."organizationId" = ${ORG_A}
			ORDER BY m."createdAt"
			LIMIT 1
		`;
		await sql`
			SELECT setval('watchers_id_seq', 1, false),
			       setval('watcher_template_versions_id_seq', 1, false)
		`;

		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
			organizationId: ORG_A,
			connectionId: connectionA,
		});

		const ids = await sql<{ id: number }>`
			SELECT id FROM watchers WHERE organization_id = ${ORG_A} ORDER BY id
		`;
		expect(ids.map(({ id }) => Number(id))).toEqual([1, 2]);
	});

	test("heals only the matching connection trigger with an unknown team", async () => {
		const svc = new BehaviorSubscriptionService();
		await svc.createChatBehavior("agent-a", "slack", CHANNEL, undefined, {
			organizationId: ORG_A,
			connectionId: connectionA,
		});
		const sql = getDb();
		const [behavior] = await sql<{ id: number; triggers: unknown[] }>`
			SELECT id, triggers
			FROM watchers
			WHERE organization_id = ${ORG_A}
			  AND tags @> ARRAY['system:chat-link']::text[]
			LIMIT 1
		`;
		await sql`
			UPDATE watchers
			SET triggers = ${sql.json([
				...behavior.triggers,
				{
					kind: "event",
					connector_key: "slack",
					connection_id: connectionA2,
					event_types: ["message.created"],
					match: { channel_id: "C123", team_id: "T2" },
					execution: "turn",
					active_run: "steer",
					output: "reply_to_source",
					skip_if_unchanged: false,
				},
			])}
			WHERE id = ${behavior.id}
		`;

		await svc.healSubscriptionTeam("a", CHANNEL, ORG_A, "T1");

		const [updated] = await sql<{
			triggers: Array<{ match: { team_id?: string } }>;
		}>`
			SELECT triggers FROM watchers WHERE id = ${behavior.id}
		`;
		expect(updated.triggers.map((trigger) => trigger.match.team_id)).toEqual([
			"T1",
			"T2",
		]);
	});

	test("rejects string connection ids before persisting an invalid trigger", async () => {
		const svc = new BehaviorSubscriptionService();
		await expect(
			svc.createChatBehavior("agent-a", "slack", CHANNEL, "T1", {
				organizationId: ORG_A,
				connectionId: String(connectionA) as never,
			}),
		).rejects.toThrow("connectionId must be a positive integer");
	});
});
