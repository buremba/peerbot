import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { insertEvent } from "../../utils/insert-event.js";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
	buildApiConversationId,
	extractThreadIdFromConversationId,
} from "../services/api-conversation-id.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-history";
const USER_ID = "user-history-1";

async function insertRun(opts: {
	organizationId: string;
	agentId: string;
	conversationId: string;
	runType?: string;
	status?: string;
}): Promise<number> {
	const sql = getDb();
	const runType = opts.runType ?? "chat_message";
	const status = opts.status ?? "completed";
	const rows = (await sql`
    INSERT INTO public.runs (
      organization_id, run_type, status, action_input,
      queue_name, run_at, created_at
    ) VALUES (
      ${opts.organizationId},
      ${runType},
      ${status},
      ${sql.json({ agentId: opts.agentId, conversationId: opts.conversationId })},
      ${runType},
      NOW(),
      NOW()
    )
    RETURNING id
  `) as Array<{ id: number }>;
	return rows[0]!.id;
}

describe("agent history routes", () => {
	let agentMetadataStore: AgentMetadataStore;
	let userAgentsStore: UserAgentsStore;

	beforeAll(async () => {
		await ensureDbForGatewayTests();
	});

	beforeEach(async () => {
		await resetTestDatabase();
		agentMetadataStore = new AgentMetadataStore(
			createPostgresAgentConfigStore(),
		);
		userAgentsStore = new UserAgentsStore();

		await orgContext.run({ organizationId: ORG_ID }, async () => {
			await seedAgentRow("agent-1", {
				organizationId: ORG_ID,
				name: "Agent 1",
				ownerPlatform: "external",
				ownerUserId: USER_ID,
			});
			await userAgentsStore.addAgent("external", USER_ID, "agent-1");
		});
	});

	afterEach(() => {
		setAuthProvider(null);
	});

	function createApp() {
		const app = new Hono();
		app.route(
			"/api/v1/agents/:agentId/history",
			createAgentHistoryRoutes({
				agentConfigStore: {
					getMetadata: (agentId: string) =>
						agentMetadataStore.getMetadata(agentId),
				},
				userAgentsStore,
			}),
		);
		return app;
	}

	test("replays pending manage_agents approvals as interactions on reload", async () => {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const agentId = "agent-1";
		const threadId = "thread-appr";
		const conversationId = buildApiConversationId({
			agentId,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId,
		});

		// A pending builder approval, stamped with the conversationId the way the
		// internal interactions route does, so the history endpoint replays it —
		// the transcript itself carries no interaction parts.
		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
			runType: "internal",
			status: "pending",
		});
		const proposal = {
			action: "update",
			agent_id: "weekly-digest",
			name: "Weekly Digest",
		};
		const current = { id: "weekly-digest", name: "Old Name" };
		await orgContext.run({ organizationId: ORG_ID }, () =>
			insertEvent({
				entityIds: [],
				organizationId: ORG_ID,
				originId: `run_${runId}_pending`,
				title: "update weekly-digest — pending approval",
				content: "Builder requested a change",
				semanticType: "operation",
				runId,
				interactionType: "approval",
				interactionStatus: "pending",
				interactionInput: proposal,
				metadata: {
					conversationId,
					action: "update",
					proposal,
					current,
					status: "pending_approval",
					run_id: runId,
				},
			}),
		);

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${agentId}/history/threads/${threadId}/messages`,
				{ method: "GET", headers: { host: "localhost" } },
			),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			interactions?: Array<{
				type: string;
				runId: number;
				action: string | null;
				proposal: Record<string, unknown> | null;
				current: Record<string, unknown> | null;
			}>;
		};
		expect(body.interactions).toHaveLength(1);
		const card = body.interactions?.[0];
		expect(card?.type).toBe("tool-approval");
		expect(card?.runId).toBe(runId);
		expect(card?.action).toBe("update");
		expect(card?.proposal).toMatchObject({ agent_id: "weekly-digest" });
		expect(card?.current).toMatchObject({ id: "weekly-digest" });
	});

	test("replays a pending entity_field_change approval with fields + attribution", async () => {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const agentId = "agent-1";
		const threadId = "thread-efc";
		const conversationId = buildApiConversationId({
			agentId,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId,
		});

		// An agent proposed changing a human-owned field; the worker stamped the
		// conversationId (via /internal/interactions/create) so it replays. The
		// entity_field_change card routes on `fields`, not `proposal`.
		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
			runType: "internal",
			status: "pending",
		});
		const fields = { "metadata.tier": "enterprise" };
		const current = { "metadata.tier": "free" };
		await orgContext.run({ organizationId: ORG_ID }, () =>
			insertEvent({
				entityIds: [],
				organizationId: ORG_ID,
				originId: `run_${runId}_pending`,
				title: "An agent proposes changing metadata.tier — pending approval",
				content: "An agent proposed updating metadata.tier on this entity.",
				semanticType: "operation",
				runId,
				interactionType: "approval",
				interactionStatus: "pending",
				interactionInput: { entity_id: 7, fields, current },
				metadata: {
					conversationId,
					tool: "entity_field_change",
					action_key: "entity_field_change",
					entity_id: 7,
					fields,
					current,
					attribution: "agent",
					status: "pending_approval",
					run_id: runId,
				},
			}),
		);

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${agentId}/history/threads/${threadId}/messages`,
				{ method: "GET", headers: { host: "localhost" } },
			),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			interactions?: Array<{
				type: string;
				runId: number;
				fields: Record<string, unknown> | null;
				current: Record<string, unknown> | null;
				attribution: string | null;
			}>;
		};
		expect(body.interactions).toHaveLength(1);
		const card = body.interactions?.[0];
		expect(card?.type).toBe("tool-approval");
		expect(card?.runId).toBe(runId);
		// The SPA routes on `fields` (non-empty) to the entity-field-change card.
		expect(card?.fields).toMatchObject({ "metadata.tier": "enterprise" });
		expect(card?.current).toMatchObject({ "metadata.tier": "free" });
		expect(card?.attribution).toBe("agent");
	});

	test("rejects sessions that do not own the requested agent", async () => {
		setAuthProvider(() => ({
			userId: "u2",
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const response = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request("/api/v1/agents/agent-1/history/threads", {
				headers: {
					host: "localhost",
				},
				method: "GET",
			}),
		);

		expect(response.status).toBe(401);
	});

	test("lists threads and returns per-thread messages from snapshots", async () => {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));

		const agentId = "agent-1";
		const threadId = "thread-a";
		const conversationId = buildApiConversationId({
			agentId,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId,
		});
		const jsonl =
			`{"type":"session","version":3,"id":"s1","timestamp":"2026-06-23T10:00:00Z","cwd":"/w"}\n` +
			`{"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-23T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Hello from server"}]}}\n` +
			`{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-06-23T10:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi there"}]}}\n`;

		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId,
			conversationId,
			status: "completed",
		});

		const sql = getDb();
		await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${ORG_ID}, ${agentId}, ${conversationId}, ${runId},
         ${jsonl}, ${Buffer.byteLength(jsonl, "utf-8")}, 'completed')
    `;

		const threadsRes = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request("/api/v1/agents/agent-1/history/threads", {
				method: "GET",
				headers: { host: "localhost" },
			}),
		);
		expect(threadsRes.status).toBe(200);
		const threadsBody = (await threadsRes.json()) as {
			threads: Array<{ id: string; title: string }>;
		};
		expect(threadsBody.threads).toEqual([
			expect.objectContaining({
				id: threadId,
				title: "Hello from server",
			}),
		]);

		const messagesRes = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/agent-1/history/threads/${threadId}/messages`,
				{
					method: "GET",
					headers: { host: "localhost" },
				},
			),
		);
		expect(messagesRes.status).toBe(200);
		const messagesBody = (await messagesRes.json()) as {
			threadId: string;
			messages: Array<{ role?: string; id: string }>;
		};
		expect(messagesBody.threadId).toBe(threadId);
		expect(messagesBody.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
		]);
	});
});

describe("agent history conversation id helpers", () => {
	test("extractThreadIdFromConversationId ignores watcher and run sessions", () => {
		expect(
			extractThreadIdFromConversationId(
				"agent-1_user-1_org-1_watcher_abc",
				"agent-1",
				"user-1",
				"org-1",
			),
		).toBeNull();
		expect(
			extractThreadIdFromConversationId(
				"agent-1_user-1_run_99",
				"agent-1",
				"user-1",
			),
		).toBeNull();
	});

	test("buildApiConversationId round-trips through extractThreadIdFromConversationId", () => {
		const conversationId = buildApiConversationId({
			agentId: "owletto-default",
			userId: "auth-user-1",
			organizationId: "org__abc",
			threadId: "d108bc64-64f",
		});
		expect(conversationId).toBe(
			"owletto-default_auth-user-1_org__abc_d108bc64-64f",
		);
		expect(
			extractThreadIdFromConversationId(
				conversationId,
				"owletto-default",
				"auth-user-1",
				"org__abc",
			),
		).toBe("d108bc64-64f");
	});
});
