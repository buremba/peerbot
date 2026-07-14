/**
 * Coverage for the config-approval prefill read:
 * `GET /:agentId/config/pending/:runId` on the org-scoped agent router.
 *
 * A builder agent's config write is held as a pending internal run; the
 * chat-history replay only surfaces its approval card in the exact originating
 * conversation, so a web config deep link can't see it. This endpoint returns
 * the held proposal by run_id (org-scoped) so a prefilled link can render the
 * change for review. Drives the real route over embedded Postgres.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { insertEvent } from "../../utils/insert-event.js";
import { orgContext } from "../stores/org-context.js";
import { authStash, installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORG = "org-pending";
const AGENT = "builder";

beforeAll(async () => {
	await ensureDbForGatewayTests();
	process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

async function seedOrgAndAgent(): Promise<void> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	await sql`
		INSERT INTO organization (id, name, slug) VALUES (${ORG}, ${ORG}, ${ORG})
		ON CONFLICT (id) DO NOTHING
	`;
	await sql`
		INSERT INTO agents (id, organization_id, name) VALUES (${AGENT}, ${ORG}, 'Builder')
		ON CONFLICT (organization_id, id) DO NOTHING
	`;
}

/** Insert a pending write-gate run + held-proposal event (queueWriteForApproval shape). */
async function insertPendingProposal(opts: {
	organizationId?: string;
	tool: "manage_agents" | "manage_watchers";
	proposal: Record<string, unknown>;
	current?: Record<string, unknown> | null;
	// The event's top-level action. manage_agents keeps `action` on the proposal;
	// manage_watchers nests it in `args`, so the producer stamps args.action into
	// metadata.action explicitly — mirror that here rather than reading it off the
	// (possibly nested) proposal.
	action?: string;
}): Promise<number> {
	const organizationId = opts.organizationId ?? ORG;
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	const rows = (await sql`
		INSERT INTO public.runs (
			organization_id, run_type, action_key, action_input,
			approval_status, status, created_at
		) VALUES (
			${organizationId}, 'internal', ${opts.tool},
			${sql.json(opts.proposal)}, 'pending', 'pending', NOW()
		)
		RETURNING id
	`) as Array<{ id: number }>;
	const runId = rows[0]!.id;
	await orgContext.run({ organizationId }, () =>
		insertEvent({
			entityIds: [],
			organizationId,
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
				action:
					opts.action ??
					(opts.proposal as { action?: string }).action ??
					(opts.proposal as { args?: { action?: string } }).args?.action ??
					null,
				proposal: opts.proposal,
				current: opts.current ?? null,
				status: "pending_approval",
				run_id: runId,
			},
		}),
	);
	return runId;
}

async function importAgentRoutes() {
	const mod = await import("../agent-routes.js");
	return mod.agentRoutes;
}

beforeEach(async () => {
	await resetTestDatabase();
	await seedOrgAndAgent();
	authStash.user = {
		id: "u1",
		name: "Test",
		email: "u1@test",
		emailVerified: true,
	};
	authStash.organizationId = ORG;
	authStash.authSource = "session";
	authStash.mcpAuthInfo = null;
}, 30_000);

describe("GET /:agentId/config/pending/:runId", () => {
	test("returns the held manage_agents proposal for the target agent", async () => {
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_agents",
			proposal: {
				action: "update",
				agent_id: AGENT,
				name: "New Name",
				identity_md: "You are helpful.",
			},
			current: { id: AGENT, name: "Old Name" },
		});

		const res = await app.request(`/${AGENT}/config/pending/${runId}`);
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
		expect(body.proposal).toMatchObject({ agent_id: AGENT, name: "New Name" });
		expect(body.current).toMatchObject({ id: AGENT });
	});

	test("404 for a manage_agents DELETE proposal (not config-form-shaped)", async () => {
		// A delete would otherwise render ordinary config fields + a generic
		// Approve that silently deletes the agent — the endpoint + form only
		// support update review, so delete/create keep the run-permalink path.
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_agents",
			proposal: { action: "delete", agent_id: AGENT },
		});
		const res = await app.request(`/${AGENT}/config/pending/${runId}`);
		expect(res.status).toBe(404);
	});

	test("404 for a manage_agents CREATE proposal", async () => {
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_agents",
			proposal: { action: "create", agent_id: AGENT, name: "New" },
		});
		const res = await app.request(`/${AGENT}/config/pending/${runId}`);
		expect(res.status).toBe(404);
	});

	test("404 for a manage_watchers run (real shape: agent_id nested in args)", async () => {
		// buildWatcherProposal returns `{ args, actingAgentId, actingWatcherId }`
		// with agent_id INSIDE args — a watcher-shaped proposal can't prefill the
		// agent config form, so this endpoint excludes it (watcher review is a
		// separate surface). Fixture matches the real ManageWatchersProposal shape.
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_watchers",
			proposal: {
				args: { action: "update", watcher_id: "w1", agent_id: AGENT, prompt: "x" },
				actingAgentId: null,
				actingWatcherId: null,
			},
		});

		const res = await app.request(`/${AGENT}/config/pending/${runId}`);
		expect(res.status).toBe(404);
	});

	test("404 when the proposal targets a DIFFERENT agent (authz boundary)", async () => {
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_agents",
			proposal: { action: "update", agent_id: "other-agent", name: "X" },
		});
		const res = await app.request(`/${AGENT}/config/pending/${runId}`);
		expect(res.status).toBe(404);
	});

	test("404 when the run belongs to a different org", async () => {
		const app = await importAgentRoutes();
		const { getDb } = await import("../../db/client.js");
		await getDb()`
			INSERT INTO organization (id, name, slug)
			VALUES ('some-other-org', 'some-other-org', 'some-other-org')
			ON CONFLICT (id) DO NOTHING
		`;
		const runId = await insertPendingProposal({
			organizationId: "some-other-org",
			tool: "manage_agents",
			proposal: { action: "update", agent_id: AGENT, name: "X" },
		});
		// authStash.organizationId is ORG; the run is in another org.
		const res = await app.request(`/${AGENT}/config/pending/${runId}`);
		expect(res.status).toBe(404);
	});

	test("404 when there is no pending run for the id", async () => {
		const app = await importAgentRoutes();
		const res = await app.request(`/${AGENT}/config/pending/999999`);
		expect(res.status).toBe(404);
	});

	test("400 on a non-numeric run id", async () => {
		const app = await importAgentRoutes();
		const res = await app.request(`/${AGENT}/config/pending/not-a-number`);
		expect(res.status).toBe(400);
	});
});

const WATCHER_ID = 501;

// The endpoint reads the watcher's owner + target from the held proposal/event
// metadata (`current.agent_id`, `args.watcher_id`), NOT from the `watchers`
// table — so no watcher row needs seeding; the proposal fixtures carry it all.

/** A real ManageWatchersProposal: `{ args: {...}, actingAgentId, actingWatcherId }`
 *  with watcher_id / agent_id nested INSIDE args. */
function watcherProposal(
	args: Record<string, unknown>,
): Record<string, unknown> {
	return { args, actingAgentId: null, actingWatcherId: null };
}

describe("GET /:agentId/watchers/:watcherId/pending/:runId", () => {
	test("returns the held manage_watchers update proposal for the target watcher", async () => {
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_watchers",
			proposal: watcherProposal({
				action: "update",
				watcher_id: WATCHER_ID,
				name: "New Watcher Name",
				prompt: "Watch for X",
			}),
			current: { id: WATCHER_ID, agent_id: AGENT, name: "Old" },
		});

		const res = await app.request(
			`/${AGENT}/watchers/${WATCHER_ID}/pending/${runId}`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			runId: number;
			resourceKind: string | null;
			action: string | null;
			proposal: Record<string, unknown> | null;
			current: Record<string, unknown> | null;
		};
		expect(body.runId).toBe(runId);
		expect(body.resourceKind).toBe("watcher");
		expect(body.action).toBe("update");
		expect(
			(body.proposal as { args?: { name?: string } }).args?.name,
		).toBe("New Watcher Name");
		expect(body.current).toMatchObject({ id: WATCHER_ID });
	});

	test("resolves the owning agent from the proposal args when it reassigns owner", async () => {
		// An update may reassign the owner via args.agent_id; the endpoint prefers
		// the PROPOSED owner over the current row so the review lands on the right
		// agent-nested route.
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_watchers",
			proposal: watcherProposal({
				action: "update",
				watcher_id: WATCHER_ID,
				agent_id: AGENT,
				name: "N",
			}),
			current: { id: WATCHER_ID, agent_id: "old-owner" },
		});
		const res = await app.request(
			`/${AGENT}/watchers/${WATCHER_ID}/pending/${runId}`,
		);
		expect(res.status).toBe(200);
	});

	test("404 for a manage_watchers CREATE proposal (not single-form review)", async () => {
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_watchers",
			proposal: watcherProposal({
				action: "create",
				watcher_id: WATCHER_ID,
				agent_id: AGENT,
			}),
		});
		const res = await app.request(
			`/${AGENT}/watchers/${WATCHER_ID}/pending/${runId}`,
		);
		expect(res.status).toBe(404);
	});

	test("404 for a manage_agents run on the watcher endpoint (wrong tool)", async () => {
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_agents",
			proposal: { action: "update", agent_id: AGENT, name: "X" },
		});
		const res = await app.request(
			`/${AGENT}/watchers/${WATCHER_ID}/pending/${runId}`,
		);
		expect(res.status).toBe(404);
	});

	test("404 when the proposal targets a DIFFERENT watcher", async () => {
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_watchers",
			proposal: watcherProposal({
				action: "update",
				watcher_id: 999,
				name: "X",
			}),
			current: { id: 999, agent_id: AGENT },
		});
		const res = await app.request(
			`/${AGENT}/watchers/${WATCHER_ID}/pending/${runId}`,
		);
		expect(res.status).toBe(404);
	});

	test("404 when the watcher is owned by a DIFFERENT agent (authz boundary)", async () => {
		const app = await importAgentRoutes();
		const runId = await insertPendingProposal({
			tool: "manage_watchers",
			proposal: watcherProposal({
				action: "update",
				watcher_id: WATCHER_ID,
				name: "X",
			}),
			current: { id: WATCHER_ID, agent_id: "other-agent" },
		});
		// Path agent is AGENT, but the watcher's owner (current + no args.agent_id)
		// is other-agent → 404.
		const res = await app.request(
			`/${AGENT}/watchers/${WATCHER_ID}/pending/${runId}`,
		);
		expect(res.status).toBe(404);
	});

	test("404 when the run belongs to a different org", async () => {
		const app = await importAgentRoutes();
		const { getDb } = await import("../../db/client.js");
		await getDb()`
			INSERT INTO organization (id, name, slug)
			VALUES ('other-w-org', 'other-w-org', 'other-w-org')
			ON CONFLICT (id) DO NOTHING
		`;
		const runId = await insertPendingProposal({
			organizationId: "other-w-org",
			tool: "manage_watchers",
			proposal: watcherProposal({
				action: "update",
				watcher_id: WATCHER_ID,
				name: "X",
			}),
			current: { id: WATCHER_ID, agent_id: AGENT },
		});
		const res = await app.request(
			`/${AGENT}/watchers/${WATCHER_ID}/pending/${runId}`,
		);
		expect(res.status).toBe(404);
	});

	test("400 on a non-numeric run id", async () => {
		const app = await importAgentRoutes();
		const res = await app.request(
			`/${AGENT}/watchers/${WATCHER_ID}/pending/not-a-number`,
		);
		expect(res.status).toBe(400);
	});
});
