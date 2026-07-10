/**
 * Real-PG tests for the write-gate v1.1 agent-envelope semantics (PR2):
 *
 *  - ORG FLOOR is a hard floor: a per-agent row can never LOOSEN a broader
 *    any-principal (org) row. The strictest matched effect wins.
 *  - The class default is a STARTING POINT, not a floor: an explicit row may
 *    loosen the default (agent_config update = auto → allow).
 *  - AUTONOMOUS ≥ ATTENDED: an autonomous-only row (principal_mode='autonomous')
 *    can only tighten the attended decision, never loosen it.
 *
 * These encode the three gaps Fable flagged; each asserts the fixed behavior
 * against a migrated database so a regression in the fold is caught here.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	evaluateEntityMutation,
	resolveWritePolicyDecision,
} from "../../../authz/entity-policy";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

async function seedPolicy(args: {
	orgId: string;
	resourceClass: string;
	principalKind?: string | null;
	principalId?: string | null;
	principalMode?: string | null;
	entityTypeSlug?: string | null;
	effects: Array<{ action: string; effect: string }>;
}): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ id: number }>`
    INSERT INTO write_approval_policies
      (organization_id, resource_class, principal_kind, principal_id,
       principal_mode, entity_type_slug, field_path, entity_id)
    VALUES
      (${args.orgId}, ${args.resourceClass}, ${args.principalKind ?? null},
       ${args.principalId ?? null}, ${args.principalMode ?? null},
       ${args.entityTypeSlug ?? null}, NULL, NULL)
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

describe("write-gate v1.1 floor + mode semantics", () => {
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	let orgId: string;
	beforeEach(async () => {
		const org = await createTestOrganization();
		orgId = org.id;
	});

	it("org floor holds: a per-agent auto cannot loosen an org approval", async () => {
		// Org (any-principal) row: delete needs approval. Agent-pinned row: delete auto.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			effects: [{ action: "delete", effect: "approval" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "auto" }],
		});
		// The strictest matched effect (approval) wins — the agent can't self-loosen.
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("require_approval");
	});

	it("org deny is an absolute floor: a per-agent auto still resolves to deny", async () => {
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			effects: [{ action: "delete", effect: "deny" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "auto" }],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("deny");
	});

	it("class default is a starting point: an explicit row loosens agent_config update to auto", async () => {
		// Default agent_config update is `approval`. An explicit org row sets auto.
		await seedPolicy({
			orgId,
			resourceClass: "agent_config",
			effects: [{ action: "update", effect: "auto" }],
		});
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "agent_config",
				principalKind: "agent",
				principalId: "agent-1",
				action: "update",
			}),
		).toBe("allow");
	});

	it("no row → class default applies (agent_config update = approval)", async () => {
		expect(
			await resolveWritePolicyDecision({
				organizationId: orgId,
				resourceClass: "agent_config",
				principalKind: "agent",
				principalId: "agent-1",
				action: "update",
			}),
		).toBe("require_approval");
	});

	it("autonomous ≥ attended: an autonomous-only deny tightens, attended stays auto", async () => {
		// A both-mode row makes delete auto; an autonomous-only row makes it deny.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "auto" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			principalMode: "autonomous",
			effects: [{ action: "delete", effect: "deny" }],
		});
		// Attended: the autonomous-only row does not apply → auto.
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
				mode: "attended",
			}),
		).toBe("allow");
		// Autonomous (watcher): the autonomous-only deny binds → deny.
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
				mode: "autonomous",
			}),
		).toBe("deny");
	});

	it("autonomous cannot loosen attended: an autonomous 'auto' can't undo an attended 'approval'", async () => {
		// Attended row: update approval. Autonomous-only row tries to set auto.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "update", effect: "approval" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			principalMode: "autonomous",
			effects: [{ action: "update", effect: "auto" }],
		});
		// Autonomous folds the attended decision (approval) as its floor → the
		// autonomous 'auto' is a no-op; the write still needs approval.
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "update",
				entityTypeSlug: "task",
				entityId: 123,
				mode: "autonomous",
			}),
		).toBe("require_approval");
	});

	it("per-type override tightens only its type; other types follow the agent default", async () => {
		// Agent default: delete auto. Per-type override for `trip`: delete deny.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "auto" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			entityTypeSlug: "trip",
			effects: [{ action: "delete", effect: "deny" }],
		});
		// trip is denied…
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "trip",
			}),
		).toBe("deny");
		// …but a different type still follows the agent default (auto).
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
			}),
		).toBe("allow");
	});
});
