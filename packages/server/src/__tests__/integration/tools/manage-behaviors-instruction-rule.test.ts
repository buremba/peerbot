/**
 * manage_behaviors — instruction-presence rule (issue #2320, thin Behaviors).
 *
 * A Behavior needs at least one instruction source (`prompt` or pinned skills)
 * only for trigger shapes that run on it alone: schedule triggers, event
 * triggers with execution "window", and no triggers (manual). An event trigger
 * with execution "turn" carries its own content and may omit both.
 *
 * create_version enforces the same rule when it writes instruction text.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { getTestDb } from "../../setup/test-db";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

const TURN_TRIGGER = {
	kind: "event",
	connector_key: "slack",
	event_types: ["message.created"],
	execution: "turn",
	output: "reply_to_source",
};

describe("manage_behaviors — instruction-presence rule", () => {
	let orgId: string;
	let ownerCtx: AuthContext;
	let agentId: string;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "instruction rule" });
		orgId = org.id;
		const owner = await createTestUser({ email: "ir-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = {
			organizationId: orgId,
			tokenOrganizationId: orgId,
			userId: owner.id,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${orgId}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
		};
		const agent = await createTestAgent({
			organizationId: orgId,
			agentId: "ir-agent",
			ownerUserId: owner.id,
		});
		agentId = agent.agentId;
		const sql = getTestDb();
		await sql`
			UPDATE agents
			SET skills_config = ${sql.json({
				skills: [
					{
						repo: "file/ir-runbook",
						name: "ir-runbook",
						enabled: true,
						content: "Run the instruction-rule workflow.",
					},
				],
			})}
			WHERE id = ${agentId} AND organization_id = ${orgId}
		`;
	});

	it("creates an event-turn Behavior with NO prompt (built-in default applies)", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-listen",
				agent_id: agentId,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };
		expect(created.behavior_id).toBeTruthy();
	});

	it("rejects a schedule Behavior with no prompt", async () => {
		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "create",
					slug: "ir-sched",
					agent_id: agentId,
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);
	});

	it("rejects a manual (no-trigger) Behavior with no prompt", async () => {
		await expect(
			executeTool(
				"manage_behaviors",
				{ action: "create", slug: "ir-manual", agent_id: agentId },
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);
	});

	it("creates and versions a schedule Behavior from pinned skills without a prompt", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-skills-only",
				agent_id: agentId,
				skills: [
					{
						name: "ir-runbook",
						content: "Run the instruction-rule workflow.",
					},
				],
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };
		expect(created.behavior_id).toBeTruthy();

		const sql = getTestDb();
		const [v1] = await sql`
			SELECT version.prompt, version.skills
			FROM behaviors behavior
			JOIN behavior_versions version ON version.id = behavior.current_version_id
			WHERE behavior.id = ${Number(created.behavior_id)}
		`;
		expect(v1.prompt).toBe("");
		expect(v1.skills).toEqual([
			{
				name: "ir-runbook",
				content: "Run the instruction-rule workflow.",
			},
		]);

		const versioned = (await executeTool(
			"manage_behaviors",
			{
				action: "create_version",
				behavior_id: created.behavior_id!,
				name: "Skills-only renamed",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);

		const [v2] = await sql`
			SELECT version.prompt, version.skills
			FROM behaviors behavior
			JOIN behavior_versions version ON version.id = behavior.current_version_id
			WHERE behavior.id = ${Number(created.behavior_id)}
		`;
		expect(v2.prompt).toBe("");
		expect(v2.skills).toEqual(v1.skills);
	});

	it("create_version rejects blanking instructions on a schedule Behavior, accepts real text", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-sched-ok",
				agent_id: agentId,
				prompt: "Daily digest instructions.",
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };
		const behaviorId = created.behavior_id!;

		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "create_version",
					behavior_id: behaviorId,
					prompt: "   ",
					set_as_current: true,
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);

		const versioned = (await executeTool(
			"manage_behaviors",
			{
				action: "create_version",
				behavior_id: behaviorId,
				prompt: "Updated digest instructions.",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("create_version allows writing empty instructions on an event-turn Behavior", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-listen-v",
				agent_id: agentId,
				prompt: "Initial listen guidance.",
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };

		const versioned = (await executeTool(
			"manage_behaviors",
			{
				action: "create_version",
				behavior_id: created.behavior_id!,
				prompt: "",
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("rejects event-turn → schedule via update when the current prompt is empty", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-turn-to-sched-update",
				agent_id: agentId,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };

		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "update",
					behavior_id: created.behavior_id!,
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);
	});

	it("rejects event-turn → schedule via create_version when prompt stays empty", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-turn-to-sched-cv",
				agent_id: agentId,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };

		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "create_version",
					behavior_id: created.behavior_id!,
					triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
					set_as_current: true,
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);
	});

	it("create_version accepts event-turn → schedule with instructions in one call", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-turn-to-sched-ok",
				agent_id: agentId,
				triggers: [TURN_TRIGGER],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };

		const versioned = (await executeTool(
			"manage_behaviors",
			{
				action: "create_version",
				behavior_id: created.behavior_id!,
				prompt: "Now scheduled digest instructions.",
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("create_version accepts schedule → event-turn with an explicit empty prompt", async () => {
		const created = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-sched-to-turn",
				agent_id: agentId,
				prompt: "Scheduled instructions.",
				triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };

		const versioned = (await executeTool(
			"manage_behaviors",
			{
				action: "create_version",
				behavior_id: created.behavior_id!,
				prompt: "",
				triggers: [TURN_TRIGGER],
				set_as_current: true,
			},
			TEST_ENV,
			ownerCtx
		)) as { version?: number };
		expect(versioned.version).toBeGreaterThan(1);
	});

	it("rejects blanking a group-shared prompt while a schedule sibling still needs it", async () => {
		const sql = getTestDb();
		const rootEntity = await createTestEntity({
			name: "IR Group Root Entity",
			organization_id: orgId,
			created_by: ownerCtx.userId!,
		});
		const siblingEntity = await createTestEntity({
			name: "IR Group Sibling Entity",
			organization_id: orgId,
			created_by: ownerCtx.userId!,
		});

		// Root assignment: schedule + shared instructions (entity-bound so
		// create_from_version can fan out another assignment in the group).
		const root = (await executeTool(
			"manage_behaviors",
			{
				action: "create",
				slug: "ir-group-root",
				agent_id: agentId,
				entity_id: rootEntity.id,
				prompt: "Shared scheduled instructions.",
				triggers: [{ kind: "schedule", cron: "0 10 * * *" }],
			},
			TEST_ENV,
			ownerCtx
		)) as { behavior_id?: string };
		const rootId = root.behavior_id!;

		const [rootRow] = await sql`
			SELECT current_version_id, behavior_group_id FROM behaviors WHERE id = ${Number(rootId)}
		`;
		const versionId = Number(rootRow.current_version_id);

		// Real second assignment in the same group — keeps schedule triggers
		// and shares the version/prompt with the root.
		const cloned = (await executeTool(
			"manage_behaviors",
			{
				action: "create_from_version",
				version_id: String(versionId),
				entity_ids: [siblingEntity.id],
			},
			TEST_ENV,
			ownerCtx
		)) as { created?: Array<{ behavior_id: string }> };
		expect(cloned.created?.[0]?.behavior_id).toBeTruthy();
		const siblingId = Number(cloned.created![0].behavior_id);

		const siblings = await sql`
			SELECT id, triggers FROM behaviors
			WHERE behavior_group_id = ${Number(rootRow.behavior_group_id)}
			ORDER BY id
		`;
		expect(siblings).toHaveLength(2);

		// Switch ONLY the targeted root to event-turn with a blank prompt.
		// The sibling still has schedule triggers → group-shared blank prompt
		// must be rejected (incoming triggers on the target do not exempt siblings).
		await expect(
			executeTool(
				"manage_behaviors",
				{
					action: "create_version",
					behavior_id: rootId,
					prompt: "",
					triggers: [TURN_TRIGGER],
					set_as_current: true,
				},
				TEST_ENV,
				ownerCtx
			)
		).rejects.toThrow(/needs instructions/i);

		// Sibling still scheduled after the rejected write.
		const [siblingAfter] = await sql`
			SELECT triggers FROM behaviors WHERE id = ${siblingId}
		`;
		const siblingTriggers = siblingAfter.triggers as Array<{ kind: string }>;
		expect(siblingTriggers.some((t) => t.kind === "schedule")).toBe(true);
	});
});
