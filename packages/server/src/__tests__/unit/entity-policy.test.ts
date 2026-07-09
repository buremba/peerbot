import { describe, expect, test } from "bun:test";
import type { DbClient } from "../../db/client";
import {
	classifyMutationPrincipal,
	evaluateEntityFieldUpdates,
	evaluateEntityMutation,
	resolveWritePolicyDecision,
} from "../../authz/entity-policy";

type PolicyRowSeed = {
	id?: number;
	resource_class?: string;
	principal_kind?: string | null;
	principal_id?: string | null;
	entity_type_slug?: string | null;
	field_path?: string | null;
	entity_id?: number | null;
	create_mode?: string;
	update_mode?: string;
	delete_mode?: string;
};

const ORG = "org-1";

/** Tagged-template stub that mimics the candidate-policy query: it applies the
 * same (NULL OR match) filters the real SQL does, against seeded rows. Param
 * order matches loadCandidatePolicies: org, resource_class, principal_kind,
 * principal_id, entity_type_slug, entity_id. */
function stubSql(seeds: PolicyRowSeed[]): DbClient {
	const rows = seeds.map((seed, index) => ({
		id: seed.id ?? index + 1,
		organization_id: ORG,
		resource_class: seed.resource_class ?? "entity",
		principal_kind: seed.principal_kind ?? null,
		principal_id: seed.principal_id ?? null,
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
		const [org, resourceClass, principalKind, principalId, entityTypeSlug, entityId] =
			params as [
				string,
				string,
				string | null,
				string | null,
				string | null,
				number | null,
			];
		return Promise.resolve(
			rows.filter(
				(row) =>
					row.organization_id === org &&
					row.resource_class === resourceClass &&
					(row.principal_kind === null ||
						(row.principal_kind === principalKind &&
							(row.principal_id === null ||
								row.principal_id === principalId))) &&
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

	test("deny mode is a hard floor — the write is denied, not queued", async () => {
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
				sql: stubSql([{ entity_type_slug: "task", create_mode: "deny" }]),
			}),
		).toBe("deny");
	});

	test("per-principal row beats a broader any-principal row", async () => {
		// Global says auto for creates; a row pinned to this one agent says approval.
		const sql = stubSql([
			{ create_mode: "auto" },
			{ principal_kind: "agent", principal_id: "agent-77", create_mode: "approval" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-77",
				action: "create",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("require_approval");
		// A different agent is unaffected and falls back to the global auto.
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-99",
				action: "create",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("allow");
	});

	test("principal-kind row (any id) applies to every agent of that kind", async () => {
		const sql = stubSql([
			{ principal_kind: "watcher", delete_mode: "deny" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "watcher",
				principalId: "watcher:5",
				action: "delete",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("deny");
		// An agent (different kind) is not matched by a watcher-kind row.
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
				sql,
			}),
		).toBe("require_approval");
	});

	test("a pinned-principal row outranks a more-scoped any-principal row", async () => {
		// entity-type row (any principal) says auto; principal row (no scope) says
		// approval. Principal specificity dominates, so the pinned agent is gated.
		const sql = stubSql([
			{ entity_type_slug: "task", update_mode: "auto" },
			{ principal_kind: "agent", principal_id: "agent-77", update_mode: "approval" },
		]);
		expect(
			await evaluateEntityMutation({
				organizationId: ORG,
				principalKind: "agent",
				principalId: "agent-77",
				action: "update",
				entityTypeSlug: "task",
				sql,
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

describe("resolveWritePolicyDecision (agent_config)", () => {
	test("a human member applies immediately regardless of policy", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "user",
				action: "update",
				sql: stubSql([{ resource_class: "agent_config", update_mode: "deny" }]),
			}),
		).toBe("allow");
	});

	test("default: agent create/update queue approval, delete is denied", async () => {
		const sql = stubSql([]);
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "create",
				sql,
			}),
		).toBe("require_approval");
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "delete",
				sql,
			}),
		).toBe("deny");
	});

	test("an org policy row can loosen the agent_config default to auto", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "update",
				sql: stubSql([{ resource_class: "agent_config", update_mode: "auto" }]),
			}),
		).toBe("allow");
	});

	test("an entity-class row does not leak into an agent_config decision", async () => {
		// Only an entity row exists; agent_config falls back to its own default.
		expect(
			await resolveWritePolicyDecision({
				organizationId: ORG,
				resourceClass: "agent_config",
				principalKind: "agent",
				action: "update",
				sql: stubSql([{ resource_class: "entity", update_mode: "auto" }]),
			}),
		).toBe("require_approval");
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

	test("deny mode on a field denies it even when human-owned", async () => {
		const decisions = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "agent",
			fields: { locked: "human", status: "none" },
			sql: stubSql([{ entity_type_slug: "task", update_mode: "deny" }]),
		});
		expect(decisions.locked).toBe("deny");
		expect(decisions.status).toBe("deny");
	});

	test("per-principal update policy gates only the pinned watcher", async () => {
		const sql = stubSql([
			{ principal_kind: "watcher", principal_id: "watcher:6", update_mode: "approval" },
		]);
		const pinned = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "watcher",
			principalId: "watcher:6",
			fields: { status: "none" },
			sql,
		});
		expect(pinned.status).toBe("require_approval");
		const other = await evaluateEntityFieldUpdates({
			...baseArgs,
			principalKind: "watcher",
			principalId: "watcher:7",
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
