/**
 * operations.getRun must fetch internal (builder / entity-change) runs, not
 * just connector action runs.
 *
 * list_runs surfaces internal runs and approve/reject act on them, but getRun
 * filtered run_type='action' and returned "Run not found" for a run the same
 * principal could list and approve. It now accepts action + internal runs.
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

	async function insertRun(run_type: string): Promise<number> {
		const db = getTestDb();
		const [row] = (await db`
      INSERT INTO runs (organization_id, run_type, action_key, status, created_at, run_at)
      VALUES (${orgId}, ${run_type}, 'propose_entity_change', 'pending', now(), now())
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
		const id = await insertRun("internal");
		const result = await getRun(id);
		expect(result.error).toBeUndefined();
		expect(result.action).toBe("get_run");
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("internal");
	});

	it("still fetches an action run", async () => {
		const id = await insertRun("action");
		const result = await getRun(id);
		const run = result.run as Record<string, unknown>;
		expect(Number(run.id)).toBe(id);
		expect(run.run_type).toBe("action");
	});

	it("does not fetch an unrelated run_type (e.g. sync)", async () => {
		const id = await insertRun("sync");
		const result = await getRun(id);
		expect(result.error).toBe("Run not found");
	});
});
