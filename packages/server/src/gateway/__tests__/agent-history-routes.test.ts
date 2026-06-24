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
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
	buildApiConversationId,
	extractThreadIdFromConversationId,
} from "../services/api-conversation-id.js";
import { truncateSnapshotJsonl } from "../services/fork-thread.js";
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

describe("truncateSnapshotJsonl", () => {
	const SESSION = `{"type":"session","version":3,"id":"s1","timestamp":"t","cwd":"/w"}`;
	const U1 = `{"type":"message","id":"u1","parentId":null,"timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`;
	const A1 = `{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}`;
	const U2 = `{"type":"message","id":"u2","parentId":"a1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"again"}]}}`;
	const A2 = `{"type":"message","id":"a2","parentId":"u2","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"sure"}]}}`;

	test("keeps the prefix up to and including the chosen message", () => {
		const jsonl = `${SESSION}\n${U1}\n${A1}\n${U2}\n${A2}\n`;
		const out = truncateSnapshotJsonl(jsonl, "a1");
		expect(out).toBe(`${SESSION}\n${U1}\n${A1}\n`);
	});

	test("returns the full blob when no message id is given", () => {
		const jsonl = `${SESSION}\n${U1}\n${A1}\n`;
		expect(truncateSnapshotJsonl(jsonl)).toBe(jsonl);
	});

	test("returns null when the message id is not found", () => {
		const jsonl = `${SESSION}\n${U1}\n${A1}\n`;
		expect(truncateSnapshotJsonl(jsonl, "nope")).toBeNull();
	});

	test("extends the cut to close dangling tool_use blocks", () => {
		const assistantWithTool = `{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"search","input":{}}]}}`;
		const toolResult = `{"type":"message","id":"tr1","parentId":"a1","timestamp":"t","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok"}]}}`;
		const jsonl = `${SESSION}\n${U1}\n${assistantWithTool}\n${toolResult}\n${A2}\n`;
		// Branch at a1 (the tool_use turn): tr1 must be pulled in so the
		// transcript has no dangling tool_use.
		const out = truncateSnapshotJsonl(jsonl, "a1");
		expect(out).toBe(`${SESSION}\n${U1}\n${assistantWithTool}\n${toolResult}\n`);
	});
});

describe("fork thread endpoint", () => {
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

	const AGENT_ID = "agent-1";
	const SOURCE_THREAD = "thread-src";
	const SESSION = `{"type":"session","version":3,"id":"s1","timestamp":"t","cwd":"/w"}`;
	const U1 = `{"type":"message","id":"u1","parentId":null,"timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"first"}]}}`;
	const A1 = `{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"reply one"}]}}`;
	const U2 = `{"type":"message","id":"u2","parentId":"a1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"second"}]}}`;
	const A2 = `{"type":"message","id":"a2","parentId":"u2","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"reply two"}]}}`;
	const SOURCE_JSONL = `${SESSION}\n${U1}\n${A1}\n${U2}\n${A2}\n`;

	async function seedSourceSnapshot(): Promise<number> {
		const conversationId = buildApiConversationId({
			agentId: AGENT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId: SOURCE_THREAD,
		});
		const runId = await insertRun({
			organizationId: ORG_ID,
			agentId: AGENT_ID,
			conversationId,
			status: "completed",
		});
		const sql = getDb();
		await sql`
      INSERT INTO public.agent_transcript_snapshot
        (organization_id, agent_id, conversation_id, run_id,
         snapshot_jsonl, byte_size, terminal_status)
      VALUES
        (${ORG_ID}, ${AGENT_ID}, ${conversationId}, ${runId},
         ${SOURCE_JSONL}, ${Buffer.byteLength(SOURCE_JSONL, "utf-8")}, 'completed')
    `;
		return runId;
	}

	function authAsOwner() {
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			exp: Date.now() + 60_000,
		}));
	}

	test("forks a thread at a chosen message into a new thread with truncated history", async () => {
		authAsOwner();
		const sourceRunId = await seedSourceSnapshot();

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${AGENT_ID}/history/threads/${SOURCE_THREAD}/fork`,
				{
					method: "POST",
					headers: { host: "localhost", "content-type": "application/json" },
					body: JSON.stringify({ throughMessageId: "a1" }),
				},
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { threadId: string };
		expect(body.threadId).toMatch(/^[a-f0-9]{12}$/);
		expect(body.threadId).not.toBe(SOURCE_THREAD);

		// New thread's snapshot is the truncated prefix, reuses the source run_id.
		const newConversationId = buildApiConversationId({
			agentId: AGENT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId: body.threadId,
		});
		const sql = getDb();
		const rows = (await sql`
      SELECT snapshot_jsonl, run_id, terminal_status
      FROM public.agent_transcript_snapshot
      WHERE organization_id = ${ORG_ID}
        AND agent_id = ${AGENT_ID}
        AND conversation_id = ${newConversationId}
    `) as Array<{
			snapshot_jsonl: string;
			run_id: number;
			terminal_status: string;
		}>;
		expect(rows).toHaveLength(1);
		expect(rows[0]!.snapshot_jsonl).toBe(`${SESSION}\n${U1}\n${A1}\n`);
		expect(Number(rows[0]!.run_id)).toBe(sourceRunId);
		expect(rows[0]!.terminal_status).toBe("completed");

		// Original thread is untouched.
		const sourceConversationId = buildApiConversationId({
			agentId: AGENT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId: SOURCE_THREAD,
		});
		const sourceRows = (await sql`
      SELECT snapshot_jsonl
      FROM public.agent_transcript_snapshot
      WHERE conversation_id = ${sourceConversationId}
    `) as Array<{ snapshot_jsonl: string }>;
		expect(sourceRows).toHaveLength(1);
		expect(sourceRows[0]!.snapshot_jsonl).toBe(SOURCE_JSONL);
	});

	test("forks the full thread when no message id is supplied", async () => {
		authAsOwner();
		await seedSourceSnapshot();

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${AGENT_ID}/history/threads/${SOURCE_THREAD}/fork`,
				{
					method: "POST",
					headers: { host: "localhost", "content-type": "application/json" },
					body: JSON.stringify({}),
				},
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { threadId: string };
		const newConversationId = buildApiConversationId({
			agentId: AGENT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			threadId: body.threadId,
		});
		const sql = getDb();
		const rows = (await sql`
      SELECT snapshot_jsonl FROM public.agent_transcript_snapshot
      WHERE conversation_id = ${newConversationId}
    `) as Array<{ snapshot_jsonl: string }>;
		expect(rows[0]!.snapshot_jsonl).toBe(SOURCE_JSONL);
	});

	test("returns 404 when the message id is not in the thread", async () => {
		authAsOwner();
		await seedSourceSnapshot();

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${AGENT_ID}/history/threads/${SOURCE_THREAD}/fork`,
				{
					method: "POST",
					headers: { host: "localhost", "content-type": "application/json" },
					body: JSON.stringify({ throughMessageId: "does-not-exist" }),
				},
			),
		);
		expect(res.status).toBe(404);
	});

	test("returns 404 when the source thread has no snapshot", async () => {
		authAsOwner();

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${AGENT_ID}/history/threads/${SOURCE_THREAD}/fork`,
				{
					method: "POST",
					headers: { host: "localhost", "content-type": "application/json" },
					body: JSON.stringify({ throughMessageId: "a1" }),
				},
			),
		);
		expect(res.status).toBe(404);
	});

	test("rejects a session that does not own the agent", async () => {
		setAuthProvider(() => ({
			userId: "intruder",
			platform: "external",
			exp: Date.now() + 60_000,
		}));
		await seedSourceSnapshot();

		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${AGENT_ID}/history/threads/${SOURCE_THREAD}/fork`,
				{
					method: "POST",
					headers: { host: "localhost", "content-type": "application/json" },
					body: JSON.stringify({ throughMessageId: "a1" }),
				},
			),
		);
		expect(res.status).toBe(401);
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
