import { describe, expect, test } from "bun:test";
import type { DbClient } from "../../db/client";
import {
	classifyMutationPrincipal,
	evaluateEntityFieldUpdates,
	evaluateEntityMutation,
} from "../../authz/entity-policy";

type PolicyRowSeed = {
	id?: number;
	entity_type_slug?: string | null;
	field_path?: string | null;
	entity_id?: number | null;
	create_mode?: string;
	update_mode?: string;
	delete_mode?: string;
};

const ORG = "org-1";

/** Tagged-template stub that mimics the candidate-policy query: it applies the
 * same (NULL OR match) filters the real SQL does, against seeded rows. */
function stubSql(seeds: PolicyRowSeed[]): DbClient {
	const rows = seeds.map((seed, index) => ({
		id: seed.id ?? index + 1,
		organization_id: ORG,
		entity_type_slug: seed.entity_type_slug ?? null,
		field_path: seed.field_path ?? null,
		entity_id: seed.entity_id ?? null,
		create_mode: seed.create_mode ?? "auto",
		update_mode: seed.update_mode ?? "auto",
		delete_mode: seed.delete_mode ?? "approval",
		approval_connection_id: null,
		approval_channel_id: null,
		approval_team_id: null,
		approval_channel_name: null,
	}));
	const sql = (_strings: TemplateStringsArray, ...params: unknown[]) => {
		const [org, entityTypeSlug, entityId] = params as [
			string,
			string | null,
			number | null,
		];
		return Promise.resolve(
			rows.filter(
				(row) =>
					row.organization_id === org &&
					(row.entity_type_slug === null ||
						row.entity_type_slug === entityTypeSlug) &&
					(row.entity_id === null || row.entity_id === entityId),
			),
		);
	};
	return sql as unknown as DbClient;
}

describe("classifyMutationPrincipal", () => {
	test("watcher source wins", () => {
		expect(
			classifyMutationPrincipal({
				userId: "u1",
				agentId: "a1",
				watcherSource: { watcher_id: 5 },
			}),
		).toBe("watcher");
	});

	test("real user session is a user", () => {
		expect(classifyMutationPrincipal({ userId: "u1" })).toBe("user");
	});

	test("agent run is an agent even with a user in context", () => {
		expect(classifyMutationPrincipal({ userId: "u1", agentId: "a1" })).toBe(
			"agent",
		);
	});

	test("system/automation context (no user, no agent) is an agent, not a user", () => {
		expect(classifyMutationPrincipal({})).toBe("agent");
	});
});

describe("evaluateEntityMutation", () => {
	test("cross-org write is denied regardless of policy", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "update",
				entityTypeSlug: "task",
				entityOrgId: "other-org",
				sql: stubSql([]),
			}),
		).toBe("deny");
	});

	test("human mutations are never gated here", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "user",
				action: "delete",
				entityTypeSlug: "task",
				sql: stubSql([]),
			}),
		).toBe("allow");
	});

	test("default policy: agent delete requires approval, create is auto", async () => {
		const sql = stubSql([]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "watcher",
				action: "delete",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("require_approval");
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("allow");
	});

	test("delete_mode auto actually disables the delete gate", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "delete",
				entityTypeSlug: "task",
				sql: stubSql([{ delete_mode: "auto" }]),
			}),
		).toBe("allow");
	});

	test("create_mode approval gates agent creates", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
				sql: stubSql([{ entity_type_slug: "task", create_mode: "approval" }]),
			}),
		).toBe("require_approval");
	});

	test("entity-scoped (row-level) policy beats the type policy", async () => {
		const sql = stubSql([
			{ entity_type_slug: "task", delete_mode: "auto" },
			{ entity_type_slug: "task", entity_id: 3202, delete_mode: "approval" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "delete",
				entityTypeSlug: "task",
				entityId: 3202,
				sql,
			}),
		).toBe("require_approval");
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "delete",
				entityTypeSlug: "task",
				entityId: 9999,
				sql,
			}),
		).toBe("allow");
	});
});

describe("evaluateEntityFieldUpdates", () => {
	const baseArgs = {
		organizationId: ORG,
		entityTypeSlug: "task",
		entityId: 3202,
		entityOrgId: ORG,
	} as const;

	test("human-owned field requires approval even when policy is auto", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "watcher",
			fields: { rationale: "human", status: "none" },
			sql: stubSql([]),
		});
		expect(decisions.rationale).toBe("require_approval");
		expect(decisions.status).toBe("allow");
	});

	test("update_mode approval gates unowned fields too", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "agent",
			fields: { status: "none" },
			sql: stubSql([{ entity_type_slug: "task", update_mode: "approval" }]),
		});
		expect(decisions.status).toBe("require_approval");
	});

	test("field-scoped policy overrides the type policy for that field only", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "agent",
			fields: { rationale: "none", status: "none" },
			sql: stubSql([
				{ entity_type_slug: "task", update_mode: "auto" },
				{
					entity_type_slug: "task",
					field_path: "rationale",
					update_mode: "approval",
				},
			]),
		});
		expect(decisions.rationale).toBe("require_approval");
		expect(decisions.status).toBe("allow");
	});

	test("entity-scoped policy gates updates to that entity only", async () => {
		const sql = stubSql([
			{ entity_type_slug: "task", entity_id: 3202, update_mode: "approval" },
		]);
		const gated = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "agent",
			fields: { status: "none" },
			sql,
		});
		expect(gated.status).toBe("require_approval");
		const other = await evaluateEntityFieldUpdates({
			...baseArgs,
			entityId: 9999,
			principalKind: "agent",
			fields: { status: "none" },
			sql,
		});
		expect(other.status).toBe("allow");
	});

	test("cross-org update denies every field", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			entityOrgId: "other-org",
			principalKind: "agent",
			fields: { status: "none" },
			sql: stubSql([]),
		});
		expect(decisions.status).toBe("deny");
	});

	test("human edits pass through untouched", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "user",
			fields: { rationale: "human" },
			sql: stubSql([]),
		});
		expect(decisions.rationale).toBe("allow");
	});
});
