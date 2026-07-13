import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { insertEvent } from "../../utils/insert-event.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentConfigRoutes } from "../routes/public/agent-config.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-pending-proposal";
const USER_ID = "user-proposal-1";

/**
 * Insert a pending builder write-gate run + its held-proposal approval event,
 * the way manage_agents/manage_watchers queueWriteForApproval does. Returns the
 * run id the prefill deep link would carry.
 */
async function insertPendingProposal(opts: {
	agentId: string;
	tool: "manage_agents" | "manage_watchers";
	proposal: Record<string, unknown>;
	current?: Record<string, unknown> | null;
}): Promise<number> {
	const sql = getDb();
	const rows = (await sql`
		INSERT INTO public.runs (
			organization_id, run_type, action_key, action_input,
			approval_status, status, created_at
		) VALUES (
			${ORG_ID}, 'internal', ${opts.tool},
			${sql.json(opts.proposal)}, 'pending', 'pending', NOW()
		)
		RETURNING id
	`) as Array<{ id: number }>;
	const runId = rows[0]!.id;
	await orgContext.run({ organizationId: ORG_ID }, () =>
		insertEvent({
			entityIds: [],
			organizationId: ORG_ID,
			originId: `run_${runId}_pending`,
			title: "pending approval",
			content: "Builder requested a change",
			semanticType: "operation",
			runId,
			interactionType: "approval",
			interactionStatus: "pending",
			interactionInput: opts.proposal,
			metadata: {
				tool: opts.tool,
				action: (opts.proposal as { action?: string }).action ?? null,
				proposal: opts.proposal,
				current: opts.current ?? null,
				status: "pending_approval",
				run_id: runId,
			},
		}),
	);
	return runId;
}

describe("agent-config pending-proposal endpoint", () => {
	let agentMetadataStore: AgentMetadataStore;
	let userAgentsStore: UserAgentsStore;

	beforeAll(async () => {
		await ensureDbForGatewayTests();
	});

	beforeEach(async () => {
		await resetTestDatabase();
		agentMetadataStore = new AgentMetadataStore(createPostgresAgentConfigStore());
		userAgentsStore = new UserAgentsStore();
		await orgContext.run({ organizationId: ORG_ID }, async () => {
			await seedAgentRow("builder", {
				organizationId: ORG_ID,
				name: "Builder",
				ownerPlatform: "external",
				ownerUserId: USER_ID,
			});
		});
		// Admin session — verifyToken short-circuits ownership; the endpoint's own
		// authz boundary (proposal.agent_id === :agentId) is what we exercise.
		setAuthProvider(() => ({
			userId: USER_ID,
			platform: "external",
			isAdmin: true,
			settingsMode: "admin",
			exp: Date.now() + 60_000,
		}));
	});

	function createApp() {
		const app = new Hono();
		app.route(
			"/api/v1/agents/:agentId/config",
			createAgentConfigRoutes({
				agentSettingsStore: {} as never,
				agentConfigStore: {
					getMetadata: (id: string) => agentMetadataStore.getMetadata(id),
					getSettings: (() => Promise.resolve(null)) as never,
				},
				userAgentsStore,
			}),
		);
		return app;
	}

	function get(agentId: string, runId: number) {
		return orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				`/api/v1/agents/${agentId}/config/pending/${runId}`,
				{ method: "GET", headers: { host: "localhost" } },
			),
		);
	}

	test("returns the held manage_agents proposal for the target agent", async () => {
		const proposal = {
			action: "update",
			agent_id: "builder",
			name: "New Name",
			identity_md: "You are helpful.",
		};
		const runId = await insertPendingProposal({
			agentId: "builder",
			tool: "manage_agents",
			proposal,
			current: { id: "builder", name: "Old Name" },
		});

		const res = await get("builder", runId);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			runId: number;
			resourceKind: string | null;
			action: string | null;
			proposal: Record<string, unknown> | null;
			current: Record<string, unknown> | null;
		};
		expect(body.runId).toBe(runId);
		expect(body.resourceKind).toBe("agent");
		expect(body.action).toBe("update");
		expect(body.proposal).toMatchObject({ agent_id: "builder", name: "New Name" });
		expect(body.current).toMatchObject({ id: "builder" });
	});

	test("flattens manage_watchers { args } proposal", async () => {
		const proposal = {
			action: "update",
			agent_id: "builder",
			args: { watcher_id: "w1", prompt: "watch for X" },
		};
		const runId = await insertPendingProposal({
			agentId: "builder",
			tool: "manage_watchers",
			proposal,
		});

		const res = await get("builder", runId);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			resourceKind: string | null;
			proposal: Record<string, unknown> | null;
		};
		expect(body.resourceKind).toBe("watcher");
		// { args } is flattened to the fields the config form binds.
		expect(body.proposal).toMatchObject({ watcher_id: "w1", prompt: "watch for X" });
	});

	test("404 when the proposal targets a DIFFERENT agent (authz boundary)", async () => {
		const runId = await insertPendingProposal({
			agentId: "other-agent",
			tool: "manage_agents",
			proposal: { action: "update", agent_id: "other-agent", name: "X" },
		});
		// Token is for 'builder', but the held proposal targets 'other-agent'.
		const res = await get("builder", runId);
		expect(res.status).toBe(404);
	});

	test("404 when there is no pending run for the id", async () => {
		const res = await get("builder", 999999);
		expect(res.status).toBe(404);
	});

	test("400 on a non-numeric run id", async () => {
		const res = await orgContext.run({ organizationId: ORG_ID }, () =>
			createApp().request(
				"/api/v1/agents/builder/config/pending/not-a-number",
				{ method: "GET", headers: { host: "localhost" } },
			),
		);
		expect(res.status).toBe(400);
	});
});
