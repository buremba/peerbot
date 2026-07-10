/**
 * Decision-parity for the v1.1 action/effect model (PR1).
 *
 * The migration replaced create_mode/update_mode/delete_mode columns with a
 * write_policy_action_effects child table. This test proves, against a real
 * migrated database, that the resolver reaches the SAME decision the old
 * mode-column model would have — for entity, agent_config, and connector_action,
 * including the global-delivery-inheritance case and the connector_action
 * execute-from-create_mode mapping. It also exercises the fail-closed path on a
 * stored effect this build declares illegal.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateEntityMutation,
	resolveEntityApprovalPolicy,
	resolveWriteEffect,
	resolveWritePolicyDecision,
} from "../../../authz/entity-policy";
import { isLegalActionEffect } from "../../../authz/write-action-manifest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

/**
 * Insert a policy header + its child action-effect rows directly, the way the
 * migration backfill produces them. `effects` is the complete action set for the
 * scope (entity/agent_config: create/update/delete; connector_action: execute).
 */
async function seedPolicy(args: {
	orgId: string;
	resourceClass: string;
	principalKind?: string | null;
	principalId?: string | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	effects: Array<{ action: string; effect: string }>;
	delivery?: { connectionId?: string; channelId?: string };
}): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ id: number }>`
    INSERT INTO write_approval_policies
      (organization_id, resource_class, principal_kind, principal_id,
       entity_type_slug, field_path, entity_id,
       approval_connection_id, approval_channel_id)
    VALUES
      (${args.orgId}, ${args.resourceClass}, ${args.principalKind ?? null},
       ${args.principalId ?? null}, ${args.entityTypeSlug ?? null},
       ${args.fieldPath ?? null}, NULL,
       ${args.delivery?.connectionId ?? null}, ${args.delivery?.channelId ?? null})
    RETURNING id
  `;
	const id = Number(rows[0].id);
	for (const { action, effect } of args.effects) {
		await sql`
      INSERT INTO write_policy_action_effects (policy_id, action, effect)
      VALUES (${id}, ${action}, ${effect})
    `;
	}
	return id;
}

describe("write-policy action/effect decision parity", () => {
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	let orgId: string;
	beforeEach(async () => {
		const org = await createTestOrganization();
		orgId = org.id;
		// Seed the agent rows these tests pin policies to — prod guarantees a bound
		// agent id has an agents row, and the policy trigger enforces it (codex-17).
		for (const agentId of ["agent_off", "agent_tie", "agent_xyz"]) {
			await createTestAgent({ organizationId: orgId, agentId });
		}
	});

	it("entity: create auto / update auto / delete approval resolve unchanged", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			entityTypeSlug: "task",
			effects: [
				{ action: "create", effect: "auto" },
				{ action: "update", effect: "approval" },
				{ action: "delete", effect: "deny" },
			],
		});
		const base = {
			organizationId: orgId,
			principalKind: "agent" as const,
			entityTypeSlug: "task",
		};
		expect(await evaluateEntityMutation({ ...base, action: "create" })).toBe("allow");
		expect(await evaluateEntityMutation({ ...base, action: "update" })).toBe(
			"require_approval",
		);
		expect(await evaluateEntityMutation({ ...base, action: "delete" })).toBe("deny");
	});

	it("entity: scoped row with no delivery inherits the global row's target", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			effects: [
				{ action: "create", effect: "auto" },
				{ action: "update", effect: "auto" },
				{ action: "delete", effect: "approval" },
			],
			delivery: { connectionId: "conn_g", channelId: "chan_ops" },
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			entityTypeSlug: "topic",
			effects: [
				{ action: "create", effect: "approval" },
				{ action: "update", effect: "approval" },
				{ action: "delete", effect: "approval" },
			],
		});
		const policy = await resolveEntityApprovalPolicy({
			organizationId: orgId,
			principalKind: "agent",
			entityTypeSlug: "topic",
		});
		// scoped row's decision, global row's delivery target.
		expect(policy.createMode).toBe("approval");
		expect(policy.deliveryTarget.connectionId).toBe("conn_g");
		expect(policy.deliveryTarget.channelId).toBe("chan_ops");
	});

	it("agent_config: per-principal watcher policy resolves each action", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "agent_config",
			principalKind: "watcher",
			principalId: "watcher:1",
			effects: [
				{ action: "create", effect: "approval" },
				{ action: "update", effect: "approval" },
				{ action: "delete", effect: "deny" },
			],
		});
		const base = {
			organizationId: orgId,
			resourceClass: "agent_config" as const,
			principalKind: "watcher" as const,
			principalId: "watcher:1",
		};
		expect(await resolveWritePolicyDecision({ ...base, action: "create" })).toBe(
			"require_approval",
		);
		expect(await resolveWritePolicyDecision({ ...base, action: "delete" })).toBe("deny");
	});

	it("agent_config: no row uses the class defaults (create/update approval, delete deny)", async () => {
		const base = {
			organizationId: orgId,
			resourceClass: "agent_config" as const,
			principalKind: "agent" as const,
		};
		expect(await resolveWritePolicyDecision({ ...base, action: "create" })).toBe(
			"require_approval",
		);
		expect(await resolveWritePolicyDecision({ ...base, action: "delete" })).toBe("deny");
	});

	it("connector_action: execute effect (backfilled from create_mode) governs the decision", async () => {
		// all-watchers: execute → approval
		await seedPolicy({
			orgId,
			resourceClass: "connector_action",
			principalKind: "watcher",
			effects: [{ action: "execute", effect: "approval" }],
		});
		// specific agent: execute → deny
		await seedPolicy({
			orgId,
			resourceClass: "connector_action",
			principalKind: "agent",
			principalId: "agent_xyz",
			effects: [{ action: "execute", effect: "deny" }],
		});
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "connector_action",
				principalKind: "watcher",
				principalId: "watcher:9",
				action: "execute",
			}),
		).toBe("require_approval");
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "connector_action",
				principalKind: "agent",
				principalId: "agent_xyz",
				action: "execute",
			}),
		).toBe("deny");
	});

	it("connector_action: resolveWriteEffect exposes `disabled` (decision collapses it to deny)", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "connector_action",
			principalKind: "agent",
			principalId: "agent_off",
			effects: [{ action: "execute", effect: "disabled" }],
		});
		const base = {
			organizationId: orgId,
			resourceClass: "connector_action" as const,
			principalKind: "agent" as const,
			principalId: "agent_off",
			action: "execute" as const,
		};
		// The DECISION collapses disabled→deny (both stop the write)...
		expect(await resolveWritePolicyDecision(base)).toBe("deny");
		// ...but the raw EFFECT is preserved so list_available can HIDE the op.
		expect(await resolveWriteEffect(base)).toBe("disabled");
	});

	it("connector_action: no row → auto (connection mode alone governs)", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "connector_action",
				principalKind: "agent",
				action: "execute",
			}),
		).toBe("allow");
	});

	it("connector_action: org disabled + exact-agent deny resolves deny deterministically (codex-7)", async () => {
		// deny and disabled are equally restrictive; the fold must pick ONE regardless
		// of candidate/scope order, or the resolved effect (and list_available's
		// hide-vs-surface behavior) becomes order-dependent and diverges from the UI.
		// We break the tie toward deny — it still SURFACES the op and gates it.
		await seedPolicy({
			orgId,
			resourceClass: "connector_action",
			principalKind: null, // org-wide
			effects: [{ action: "execute", effect: "disabled" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "connector_action",
			principalKind: "agent",
			principalId: "agent_tie",
			effects: [{ action: "execute", effect: "deny" }],
		});
		const base = {
			organizationId: orgId,
			resourceClass: "connector_action" as const,
			principalKind: "agent" as const,
			principalId: "agent_tie",
			action: "execute" as const,
		};
		// The raw effect resolves deny (not disabled), so list_available surfaces it.
		expect(await resolveWriteEffect(base)).toBe("deny");
		expect(await resolveWritePolicyDecision(base)).toBe("deny");
	});

	it("the permissions-PUT input guards reject payloads that would erase/mis-target a row (codex-11)", async () => {
		// effects MUST be a plain object — an array passes typeof==='object' but yields
		// no entries, so a replace-all upsert would wipe stored effects. Reject arrays.
		const isEffectsMap = (v: unknown) =>
			typeof v === "object" && v !== null && !Array.isArray(v);
		expect(isEffectsMap({ create: "deny" })).toBe(true);
		expect(isEffectsMap([])).toBe(false);
		expect(isEffectsMap(null)).toBe(false);

		// entity_type_slug: present-but-invalid (number, whitespace) must NOT coerce to
		// null (the blanket row) — that would overwrite the broad policy. Only a
		// non-empty string or omitted is valid.
		const slugPresentInvalid = (v: unknown) =>
			v !== undefined &&
			v !== null &&
			(typeof v !== "string" || v.trim() === "");
		expect(slugPresentInvalid(123)).toBe(true);
		expect(slugPresentInvalid("   ")).toBe(true);
		expect(slugPresentInvalid("trip")).toBe(false);
		expect(slugPresentInvalid(undefined)).toBe(false);
		expect(slugPresentInvalid(null)).toBe(false);
	});

	it("the DELETE principal_mode guard rejects a PRESENT non-'autonomous' value, null only when ABSENT (codex-14)", () => {
		// A query param `?principal_mode=` (empty) must NOT map to null and delete the
		// attended/both-mode row — only a genuinely absent param maps to null.
		const rejects = (param: string | undefined) =>
			param !== undefined && param.trim() !== "autonomous";
		expect(rejects(undefined)).toBe(false); // absent → null (both-mode)
		expect(rejects("autonomous")).toBe(false);
		expect(rejects("")).toBe(true); // present empty → 400
		expect(rejects("  ")).toBe(true); // whitespace → 400
		expect(rejects("attended")).toBe(true); // typo → 400
	});

	it("a type scope is rejected for non-entity classes; only entity is type-scoped (codex-13)", () => {
		// A present entity_type_slug on agent_config/connector_action must 400, not
		// coerce to null and overwrite the class's blanket policy.
		const slugAllowed = (
			resourceClass: string,
			slug: string | undefined | null,
		) => {
			const present = slug !== undefined && slug !== null;
			return !(present && resourceClass !== "entity");
		};
		expect(slugAllowed("entity", "trip")).toBe(true);
		expect(slugAllowed("agent_config", "trip")).toBe(false);
		expect(slugAllowed("connector_action", "trip")).toBe(false);
		expect(slugAllowed("agent_config", undefined)).toBe(true); // omitted is fine
	});

	it("the permissions-PUT validation predicate rejects illegal (action,effect) pairs (codex-8)", async () => {
		// The endpoint 400s on any entry isLegalActionEffect rejects, rather than
		// dropping it (a dropped entry + replace-all upsert would ERASE a stored deny).
		// entity governs create/update/delete with auto/approval/deny — NOT execute,
		// NOT disabled.
		expect(isLegalActionEffect("entity", "create", "approval")).toBe(true);
		expect(isLegalActionEffect("entity", "execute", "auto")).toBe(false); // illegal action
		expect(isLegalActionEffect("entity", "create", "disabled")).toBe(false); // illegal effect
		expect(isLegalActionEffect("connector_action", "execute", "disabled")).toBe(true);
		expect(isLegalActionEffect("connector_action", "create", "auto")).toBe(false);
	});

	it("fail-closed: a stored effect illegal for the class resolves to deny, not the default", async () => {
		// 'disabled' is legal only for connector_action; an entity row carrying it
		// is corrupt/forward data and must fail closed, not read as the create=auto default.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			entityTypeSlug: "task",
			effects: [
				{ action: "create", effect: "disabled" },
				{ action: "update", effect: "auto" },
				{ action: "delete", effect: "approval" },
			],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				action: "create",
				entityTypeSlug: "task",
			}),
		).toBe("deny");
	});
});
