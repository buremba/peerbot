/**
 * Cross-repo wire coverage for the Owletto agent list.
 *
 * The database and public AgentItem contract both use Automation vocabulary:
 * owletto declares `automationCount`, so the server has to emit that key.
 * Nothing in owletto reads the field today, so a key mismatch produces no type
 * error and no visibly broken screen — this server-side assertion is the only
 * thing that catches it.
 */
import { beforeAll, beforeEach, expect, test } from "bun:test";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
	seedAgentRow,
} from "../../gateway/__tests__/helpers/db-setup.js";
import { authStash, installRouteTestMocks } from "./helpers/route-test-mocks";

installRouteTestMocks();

const ORG = "org-agent-list-counts";
const AGENT = "counted-agent";

beforeAll(async () => {
	await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
	await resetTestDatabase();
	await seedAgentRow(AGENT, { organizationId: ORG, name: "Counted Agent" });
	// The stashes are process-global and shared with every other file in this
	// directory (they all run in one `bun test` process), so set every field this
	// file depends on rather than inheriting a neighbour's last value.
	authStash.user = {
		id: "u1",
		name: "Test",
		email: "u1@test",
		emailVerified: true,
	};
	authStash.organizationId = ORG;
	authStash.authSource = "session";
	authStash.mcpAuthInfo = null;

	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	await sql`
		INSERT INTO "user" (
			id, name, email, "emailVerified", "createdAt", "updatedAt"
		) VALUES (
			'test-user', 'Test User', 'test-user@example.com', true, now(), now()
		)
	`;
	// One active Automation plus one archived one: the count query filters on
	// status, so the archived row is what keeps `automationCount: 1` from passing
	// on a mere "some rows exist" read.
	await sql`
		INSERT INTO automations (
			id, organization_id, slug, name, agent_id, created_by,
			automation_group_id, status
		) VALUES (
			9001, ${ORG}, 'counted-automation', 'Counted Automation', ${AGENT},
			'test-user', 9001, 'active'
		), (
			9002, ${ORG}, 'archived-automation', 'Archived Automation', ${AGENT},
			'test-user', 9002, 'archived'
		)
	`;
});

test("GET / exposes active automation rows as automationCount", async () => {
	const { agentRoutes } = await import("../agent-routes.js");
	const response = await agentRoutes.request("/");
	expect(response.status).toBe(200);

	const body = (await response.json()) as {
		agents: Array<Record<string, unknown>>;
	};
	const agent = body.agents.find((item) => item.agentId === AGENT);
	expect(agent).toMatchObject({ agentId: AGENT, automationCount: 1 });
});
