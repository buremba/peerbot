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
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestAgent,
	createTestEntity,
	createTestOrganization,
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

	async function createCloneFixture(query: string) {
		const { org, user, ctx } = await seedOwnerContext();
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		const sourceEntity = await createTestEntity({
			name: `cfv-source-${Date.now()}`,
			organization_id: org.id,
			created_by: user.id,
		});
		const targetEntity = await createTestEntity({
			name: `cfv-target-${Date.now()}`,
			organization_id: org.id,
			created_by: user.id,
		});
		const created = await manageBehaviors(
			{
				action: "create",
				slug: `cfv-src-${Date.now()}`,
				name: "Clone source",
				prompt: "Summarize.",
				agent_id: agent.agentId,
				entity_id: Number(sourceEntity.id),
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
		if (created.action !== "create" || !("behavior_id" in created)) {
			throw new Error("setup: create failed");
		}
		const [row] = await getTestDb()<{ current_version_id: number }[]>`
			SELECT current_version_id FROM watchers WHERE id = ${String(created.behavior_id)}
		`;
		return {
			ctx,
			organizationId: org.id,
			targetEntityId: Number(targetEntity.id),
			versionId: Number(row.current_version_id),
		};
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
		// Unknown names compile as empty entity-type CTEs, so `evetns` would not
		// otherwise produce a Postgres error.
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

	it("accepts a source referencing a public-catalog entity_type slug", async () => {
		const { org, user, ctx } = await seedOwnerContext();
		const catalogOrg = await createTestOrganization({ visibility: "public" });
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		await getTestDb()`
			INSERT INTO entity_types (organization_id, slug, name)
			VALUES (${catalogOrg.id}, 'catalog-company', 'Catalog Company')
		`;

		const created = await manageBehaviors(
			{
				action: "create",
				slug: `src-public-slug-${Date.now()}`,
				name: "Public slug source",
				prompt: "Summarize.",
				agent_id: agent.agentId,
				sources: [{ name: "src", query: 'SELECT id FROM "catalog-company"' }],
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

	it("validates cloned sources on create_from_version too", async () => {
		const { ctx, organizationId, targetEntityId, versionId } =
			await createCloneFixture("SELECT id FROM events WHERE 1=0");

		// Simulate a referenced table being dropped after the version was authored.
		await getTestDb()`
			UPDATE watcher_versions
			SET version_sources = ${getTestDb().json([
				{ name: "src", query: "SELECT id FROM evetns" },
			])}
			WHERE id = ${versionId}
		`;

		await expect(
			manageBehaviors(
				{
					action: "create_from_version",
					version_id: String(versionId),
					entity_ids: [targetEntityId],
				},
				env,
				ctx,
			),
		).rejects.toThrow(/unknown table or entity type|evetns/i);

		const [{ n }] = await getTestDb()<{ n: string }[]>`
			SELECT COUNT(*)::text AS n FROM watchers
			WHERE organization_id = ${organizationId} AND ${targetEntityId} = ANY(entity_ids)
		`;
		expect(Number(n)).toBe(0);
	});

	it("clones a valid source using the target entity context", async () => {
		const { ctx, targetEntityId, versionId } = await createCloneFixture(
			"SELECT id FROM events WHERE {{entityId}} = ANY(entity_ids)",
		);
		const cloned = (await manageBehaviors(
			{
				action: "create_from_version",
				version_id: String(versionId),
				entity_ids: [targetEntityId],
			},
			env,
			ctx,
		)) as { created: Array<{ behavior_id: string }> };
		expect(cloned.created).toHaveLength(1);
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
