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
import {
	createTestAgent,
	createTestEntity,
	seedOwnerContext,
} from "../setup/test-fixtures";

const env = {} as Env;

describe("behavior custom-SQL source validation", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	async function createWithSource(
		query: string,
		opts: { entityBound?: boolean } = {},
	) {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const entity = opts.entityBound
			? await createTestEntity({
					name: `src-validate-entity-${Date.now()}`,
					organization_id: org.id,
					created_by: user.id,
				})
			: null;
		return manageBehaviors(
			{
				action: "create",
				slug: `src-validate-${Date.now()}`,
				name: "Source validate",
				prompt: "Summarize.",
				agent_id: agent.agentId,
				...(entity ? { entity_id: Number(entity.id) } : {}),
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

	it("rejects a source referencing a non-existent table (typo, not a real slug)", async () => {
		// A bad table name is NOT a Postgres error — the scoped-query layer rewrites
		// any unknown name into an entity_type-slug CTE that matches 0 rows. Without
		// the slug-existence check this would be accepted and run "healthy" forever
		// with no content. `evetns` is neither a table nor an org entity-type slug.
		await expect(
			createWithSource("SELECT id FROM evetns"),
		).rejects.toThrow(/unknown table or entity type|evetns/i);
	});

	it("accepts a source referencing a real entity_type slug as a table", async () => {
		// `company` is a valid entity_type slug (created below), so referencing it
		// as a table compiles to the entity-slug CTE and must be accepted.
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		await createTestEntity({
			name: `slug-src-company-${Date.now()}`,
			entity_type: "company",
			organization_id: org.id,
			created_by: user.id,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				slug: `src-slug-${Date.now()}`,
				name: "Slug source",
				prompt: "Summarize.",
				agent_id: agent.agentId,
				sources: [{ name: "src", query: "SELECT id FROM company" }],
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
		expect(created.action).toBe("create");
		expect("behavior_id" in created).toBe(true);
	});

	it("accepts a {{entityId}} source on an entity-bound behavior", async () => {
		// The behavior has an entity_id, so {{entityId}} resolves at run time —
		// validation must accept it (not trip the Unknown-context-variables guard).
		const created = await createWithSource(
			"SELECT id FROM events WHERE {{entityId}} = ANY(entity_ids)",
			{ entityBound: true },
		);
		expect(created.action).toBe("create");
		expect("behavior_id" in created).toBe(true);
	});

	it("rejects a {{entityId}} source on an org-scoped behavior", async () => {
		// No entity binding → {{entityId}} never resolves at run time, so the
		// source would fail on every read. Reject it at save instead of accepting
		// a silently-broken source.
		await expect(
			createWithSource(
				"SELECT id FROM events WHERE {{entityId}} = ANY(entity_ids)",
			),
		).rejects.toThrow();
	});

	it("validates custom SQL on create_version too, not only create", async () => {
		// Create a valid behavior, then publish a new version whose source has a
		// bad column — the create_version path (version-actions) must reject it,
		// same as create.
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				slug: `src-cv-${Date.now()}`,
				name: "Source create_version",
				prompt: "Summarize.",
				agent_id: agent.agentId,
				sources: [{ name: "src", query: "SELECT id FROM events WHERE 1=0" }],
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
		if (created.action !== "create" || !("behavior_id" in created)) {
			throw new Error("setup: create failed");
		}
		const behaviorId = String(created.behavior_id);

		await expect(
			manageBehaviors(
				{
					action: "create_version",
					behavior_id: behaviorId,
					sources: [
						{ name: "src", query: "SELECT id, this_is_not_a_column FROM events" },
					],
				},
				env,
				ctx,
			),
		).rejects.toThrow(/this_is_not_a_column|column|does not exist/i);
	});
});
