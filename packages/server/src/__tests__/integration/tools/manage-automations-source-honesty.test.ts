/**
 * An Automation's sources are Automation-authored; its instruction text is not an
 * input to them. Issue #2320 must-fix 2.
 *
 * Since #2331 the `prompt` column holds the compiled join of the skill bodies
 * an Automation named, so re-deriving `sources[]` from its `@`-chips let a
 * skill's prose author the list — and because derivation REPLACED, a compiled
 * prompt with no chips erased every stored source, the default `content` one
 * included. `lobu apply` resends `prompt` on every bump, so that needed no
 * user intent at all.
 *
 * `get_version_details` told the mirror-image lie: `version_sources` is NULL
 * on every row `create_version` writes (sources are per-assignment), so it
 * reported `sources: []` for an Automation that plainly had them — and it looked
 * versions up on the passed id while `get_versions` resolves the group root,
 * so an assignment could list a version it then could not fetch.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { DEFAULT_AUTOMATION_SOURCE_QUERY } from "../../../automations/source-refs";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

/** Compiled skill prose that happens to match the composer's chip codec. */
const SKILL_BODY_WITH_CHIP = [
	"# Daily digest",
	"",
	"Summarise overnight activity. Pull the numbers from",
	"@[sql:skill_pull:Skill Pull](#sql=SELECT%20id%20FROM%20events) before writing.",
].join("\n");

const RECENT_QUERY = "SELECT id FROM events ORDER BY occurred_at DESC";

type Sources = Array<{ name: string; query: string }>;

describe("manage_automations — create_version source ownership", () => {
	let orgId: string;
	let ownerCtx: AuthContext;
	let agentId: string;

	const baseCtx = (orgIdValue: string, userId: string): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole: "owner",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgIdValue}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	});

	async function createAutomation(slug: string): Promise<string> {
		const created = (await executeTool(
			"manage_automations",
			{
				action: "create",
				slug,
				name: "Digest",
				prompt: "Write the digest.",
				managed_agent_id: agentId,
			},
			TEST_ENV,
			ownerCtx
		)) as { automation_id?: string };
		return created.automation_id!;
	}

	async function storedSources(automationId: string): Promise<Sources> {
		const sql = getTestDb();
		const rows = await sql`SELECT sources FROM automations WHERE id = ${automationId}`;
		return (rows[0] as { sources: Sources | null }).sources ?? [];
	}

	async function createVersion(
		automationId: string,
		args: Record<string, unknown>
	): Promise<void> {
		await executeTool(
			"manage_automations",
			{ action: "create_version", automation_id: automationId, ...args },
			TEST_ENV,
			ownerCtx
		);
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();

		const org = await createTestOrganization({ name: "automation source honesty" });
		orgId = org.id;
		const owner = await createTestUser({ email: "bsh-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = baseCtx(org.id, owner.id);

		const agent = await createTestAgent({
			organizationId: org.id,
			agentId: "bsh-agent",
			ownerUserId: owner.id,
		});
		agentId = agent.agentId;
	});

	it("keeps sources independent from instruction text", async () => {
		const automationId = await createAutomation("bsh-digest");
		expect(await storedSources(automationId)).toEqual([
			{ name: "content", query: DEFAULT_AUTOMATION_SOURCE_QUERY },
		]);

		await createVersion(automationId, { prompt: SKILL_BODY_WITH_CHIP });
		expect(await storedSources(automationId)).toEqual([
			{ name: "content", query: DEFAULT_AUTOMATION_SOURCE_QUERY },
		]);

		await createVersion(automationId, { prompt: "Write the digest, briefly." });
		expect(await storedSources(automationId)).toEqual([
			{ name: "content", query: DEFAULT_AUTOMATION_SOURCE_QUERY },
		]);

		await createVersion(automationId, {
			prompt: SKILL_BODY_WITH_CHIP,
			sources: [{ name: "recent", query: RECENT_QUERY }],
		});
		expect(await storedSources(automationId)).toEqual([
			{ name: "recent", query: RECENT_QUERY },
		]);

		await createVersion(automationId, { sources: [] });
		expect(await storedSources(automationId)).toEqual([]);

		await createVersion(automationId, {
			sources: [{ name: "recent", query: RECENT_QUERY }],
		});
		expect(await storedSources(automationId)).toEqual([
			{ name: "recent", query: RECENT_QUERY },
		]);

		const details = (await executeTool(
			"manage_automations",
			{ action: "get_version_details", automation_id: automationId },
			TEST_ENV,
			ownerCtx
		)) as { version: number; sources: Sources };

		expect(details.version).toBeGreaterThan(1);
		expect(details.sources).toEqual([
			{ name: "recent", query: RECENT_QUERY },
		]);

		const listed = (await executeTool(
			"manage_automations",
			{ action: "get_versions", automation_id: automationId },
			TEST_ENV,
			ownerCtx
		)) as { versions: Array<{ version: number }> };

		for (const { version } of listed.versions) {
			const details = (await executeTool(
				"manage_automations",
				{ action: "get_version_details", automation_id: automationId, version },
				TEST_ENV,
				ownerCtx
			)) as { version: number };
			expect(details.version).toBe(version);
		}
	});

	it("gets group-root versions through an assignment id", async () => {
		const automationId = await createAutomation("bsh-assignment");
		await createVersion(automationId, { prompt: "Write the digest, briefly." });
		const sql = getTestDb();
		const entity = await createTestEntity({
			name: "Source Honesty Co",
			organization_id: orgId,
		});
		const [root] = await sql<{ current_version_id: number }>`
			SELECT current_version_id FROM automations WHERE id = ${automationId}
		`;
		const assigned = (await executeTool(
			"manage_automations",
			{
				action: "create_from_version",
				version_id: String(root.current_version_id),
				entity_ids: [entity.id],
			},
			TEST_ENV,
			ownerCtx
		)) as { created: Array<{ automation_id: string }> };
		const assignmentId = assigned.created[0].automation_id;
		expect(assignmentId).not.toBe(automationId);

		const listed = (await executeTool(
			"manage_automations",
			{ action: "get_versions", automation_id: assignmentId },
			TEST_ENV,
			ownerCtx
		)) as { versions: Array<{ version: number }> };
		expect(listed.versions.length).toBeGreaterThan(0);

		for (const { version } of listed.versions) {
			const details = (await executeTool(
				"manage_automations",
				{ action: "get_version_details", automation_id: assignmentId, version },
				TEST_ENV,
				ownerCtx
			)) as { version: number };
			expect(details.version).toBe(version);
		}
	});
});
