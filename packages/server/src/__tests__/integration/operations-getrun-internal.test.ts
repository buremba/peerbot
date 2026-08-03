/**
 * get_run must fetch ANY run_type that list_runs surfaces — action, internal,
 * behavior, sync — not just action. list_runs shows every operational run
 * (everything except the chat_message transport lane), and approve/reject act
 * on them, but get_run filtered run_type IN ('action','internal') and returned
 * "Run not found" for a behavior/sync run the same principal could list. It now
 * shares the list's excluded-types set, so any listed run is fetchable; only
 * chat_message (the list's default exclusion) stays unfetchable.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageOperations } from "../../tools/admin/manage_operations";
import type { ToolContext } from "../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestOrganization, createTestUser } from "../setup/test-fixtures";

const env = {} as Env;

describe("manage_operations get_run — internal runs", () => {
	let orgId: string;

	const ctx = (): ToolContext => ({
		organizationId: orgId,
		userId: "getrun-owner",
		memberRole: "owner",
		isAuthenticated: true,
		tokenType: "oauth",
		scopes: ["mcp:admin"],
		scopedToOrg: false,
		allowCrossOrg: false,
	});

	async function insertRun(
		runType: "action" | "internal" | "sync" | "behavior" | "chat_message",
		actionKey: string | null,
	): Promise<number> {
		const db = getTestDb();
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status, created_at, run_at)
      VALUES (${orgId}, ${runType}, ${actionKey}, 'pending', now(), now())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		return Number(row.id);
	}

	async function getRun(runId: number): Promise<Record<string, unknown>> {
		return (await manageOperations(
			{ action: "get_run", run_id: runId },
			env,
			ctx(),
		)) as Record<string, unknown>;
	}

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "GetRun Internal Org" });
		orgId = org.id;
	});

	it("fetches an internal run instead of reporting 'Run not found'", async () => {
		const id = await insertRun("internal", "manage_agents");
		const result = await getRun(id);
		expect(result.error).toBeUndefined();
		expect(result.action).toBe("get_run");
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("internal");
	});

	it("still fetches an action run", async () => {
		const id = await insertRun("action", "test_action");
		const result = await getRun(id);
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("action");
	});

	it("fetches a sync run (listed operationally, so must be gettable)", async () => {
		const id = await insertRun("sync", null);
		const result = await getRun(id);
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("sync");
	});

	it("fetches a behavior run (listed operationally, so must be gettable)", async () => {
		const id = await insertRun("behavior", "propose_entity_change");
		const result = await getRun(id);
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("behavior");
	});

	it("does NOT fetch a chat_message transport run (excluded from the operational list)", async () => {
		const id = await insertRun("chat_message", "thread_response");
		const result = await getRun(id);
		expect(result.error).toBe("Run not found");
	});

	it("surfaces the recorded initiator through get_run and list_runs", async () => {
		const db = getTestDb();
		const proposer = await createTestUser();
		const initiatorRef = {
			agent_id: "personal-agent",
			client_id: "claude-ai",
			user_id: proposer.id,
		};
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status,
        approval_status, created_by_user_id, initiator_kind, initiator_ref,
        created_at, run_at)
      VALUES (${orgId}, 'internal', 'entity_change', 'pending', 'pending',
        ${proposer.id}, 'agent_session',
        ${db.json(initiatorRef)},
        now(), now())
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const id = Number(row.id);

		const got = (await getRun(id)).run as Record<string, unknown>;
		expect(got.initiator_kind).toBe("agent_session");
		expect(got.created_by_user_id).toBe(proposer.id);
		expect(got.initiator_ref).toEqual(initiatorRef);

		const listed = (await manageOperations(
			{
				action: "list_runs",
				run_types: ["internal"],
				approval_status: "pending",
			},
			env,
			ctx(),
		)) as { runs: Array<Record<string, unknown>> };
		const found = listed.runs.find((r) => Number(r.id) === id);
		expect(found?.initiator_kind).toBe("agent_session");
		expect(found?.created_by_user_id).toBe(proposer.id);
		expect(found?.initiator_ref).toEqual(initiatorRef);
	});

	it("uses Behavior vocabulary for every platform-owned public run field", async () => {
		const db = getTestDb();
		const creator = await createTestUser();
		const [behavior] = (await db`
			WITH next_id AS (
				SELECT nextval('behaviors_id_seq')::integer AS id
			)
			INSERT INTO behaviors (
				id, behavior_group_id, organization_id, agent_id, created_by, name, slug
			)
			SELECT id, id, ${orgId}, 'personal-agent', ${creator.id}, 'Public vocabulary', 'public-vocabulary'
			FROM next_id
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		const behaviorId = Number(behavior.id);
		const [row] = (await db`
			INSERT INTO runs (
				organization_id, run_type, action_key, action_input, behavior_id,
				status, approval_status,
				initiator_kind, initiator_ref, created_at, run_at
			)
			VALUES (
				${orgId}, 'internal', 'entity_field_change',
				${db.json({
					behavior_id: behaviorId,
					entity_id: 42,
					fields: { status: "reviewed" },
				})},
				${behaviorId}, 'completed', 'auto',
				'behavior',
				${db.json({ behavior_id: behaviorId, window_id: 17, run_id: 18 })},
				now(), now()
			)
			RETURNING id
		`) as unknown as Array<{ id: number }>;
		const runId = Number(row.id);

		const listed = (await manageOperations(
			{ action: "list_runs", run_types: ["internal"] },
			env,
			ctx(),
		)) as { runs: Array<Record<string, unknown>> };
		const listedRun = listed.runs.find((run) => Number(run.id) === runId);
		expect(listedRun?.behavior_id).toBe(behaviorId);
		expect(listedRun?.initiator_ref).toEqual({
			behavior_id: behaviorId,
			window_id: 17,
			run_id: 18,
		});
		expect(listedRun?.input).toEqual({
			behavior_id: behaviorId,
			entity_id: 42,
			fields: { status: "reviewed" },
		});

		const got = (await getRun(runId)).run as Record<string, unknown>;
		expect(got.behavior_id).toBe(behaviorId);
		expect(got.initiator_ref).toEqual({
			behavior_id: behaviorId,
			window_id: 17,
			run_id: 18,
		});
		expect(got.input).toEqual({
			behavior_id: behaviorId,
			entity_id: 42,
			fields: { status: "reviewed" },
		});

		const activity = (await manageOperations(
			{
				action: "list_activity",
				include_notifications: false,
				aggregate: false,
			},
			env,
			ctx(),
		)) as { items: Array<Record<string, unknown>> };
		const card = activity.items.find((item) => Number(item.run_id) === runId);
		expect(card?.behavior_id).toBe(behaviorId);
	});
});
