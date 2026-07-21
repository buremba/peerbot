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
import { createTestOrganization } from "../setup/test-fixtures";

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
});
