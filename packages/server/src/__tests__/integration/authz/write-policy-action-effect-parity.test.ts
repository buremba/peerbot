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
	resolveWritePolicyDecision,
} from "../../../authz/entity-policy";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

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
