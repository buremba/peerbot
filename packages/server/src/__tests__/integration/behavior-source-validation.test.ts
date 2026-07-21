/**
 * Behavior custom-SQL source validation at save time.
 *
 * A Behavior source query referencing a non-existent COLUMN used to be accepted
 * by behaviors.create with zero validation: the scoped-query layer swallows the
 * Postgres 42703 error into an empty result at read time, so the Behavior ran
 * "green" forever (health healthy, 0 content) with no operator signal. The
 * create/update path now validates each custom-SQL source (plans it LIMIT 0 and
 * throws on failure), so a broken column is rejected up front. A structurally
 * valid query that merely matches 0 rows is still accepted.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageBehaviors } from "../../tools/admin/manage_behaviors";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase } from "../setup/test-db";
import { createTestAgent, seedOwnerContext } from "../setup/test-fixtures";

const env = {} as Env;

describe("behavior custom-SQL source validation", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	async function createWithSource(query: string) {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		return manageBehaviors(
			{
				action: "create",
				slug: `src-validate-${Date.now()}`,
				name: "Source validate",
				prompt: "Summarize.",
				agent_id: agent.agentId,
				sources: [{ name: "src", query }],
				triggers: [
					{
						kind: "schedule",
						cron: "* * * * *",
						execution: "window",
						active_run: "coalesce",
					},
				],
			},
			env,
			ctx,
		);
	}

	it("rejects a source that references a non-existent column", async () => {
		// Projects `id` (so it passes the id-projection guard) but references a
		// bogus column — must be caught by the new scoped-query validation, not
		// swallowed into 0 rows at read time.
		await expect(
			createWithSource(
				"SELECT id, this_is_not_a_column FROM events",
			),
		).rejects.toThrow(/this_is_not_a_column|column|does not exist/i);
	});

	it("accepts a valid source that matches zero rows", async () => {
		const created = await createWithSource(
			"SELECT id FROM events WHERE 1=0",
		);
		expect(created.action).toBe("create");
		expect("behavior_id" in created).toBe(true);
	});

	it("accepts a valid source that uses the {{entityId}} template variable", async () => {
		// Save-time validation must substitute template variables like the reader
		// does, not reject them as "Unknown context variables".
		const created = await createWithSource(
			"SELECT id FROM events WHERE {{entityId}} = ANY(entity_ids)",
		);
		expect(created.action).toBe("create");
		expect("behavior_id" in created).toBe(true);
	});
});
