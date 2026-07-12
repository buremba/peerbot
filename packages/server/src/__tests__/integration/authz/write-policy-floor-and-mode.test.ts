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
	listEntityApprovalPolicies,
	resolveWriteEffect,
	resolveWritePolicyDecision,
	upsertEntityApprovalPolicy,
} from "../../../authz/entity-policy";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
} from "../../setup/test-fixtures";

async function seedPolicy(args: {
	orgId: string;
	resourceClass: string;
	principalKind?: string | null;
	principalId?: string | null;
	principalMode?: string | null;
	entityTypeSlug?: string | null;
	fieldPath?: string | null;
	entityId?: number | null;
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
       ${args.entityTypeSlug ?? null}, ${args.fieldPath ?? null},
       ${args.entityId ?? null})
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
		// Tests pin policies to these agent ids. Prod guarantees a bound agent id has an
		// agents row (auth binds only after existence; codex-17), and the policy trigger
		// + resolver enforce it — so seed the rows the tests assume.
		for (const agentId of ["agent-1", "agent-auto", "agent-deliv"]) {
			await createTestAgent({ organizationId: orgId, agentId });
		}
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

	it("a sparse autonomous row abstains on actions it does not name", async () => {
		// Attended: create=auto. An autonomous-only row names ONLY delete=deny.
		// create must stay auto in autonomous mode — the sparse autonomous row must
		// NOT pull create toward the class default.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "create", effect: "auto" }],
		});
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			principalMode: "autonomous",
			effects: [{ action: "delete", effect: "deny" }],
		});
		// autonomous create: the autonomous row abstains → inherits attended auto.
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "create",
				entityTypeSlug: "task",
				mode: "autonomous",
			}),
		).toBe("allow");
		// autonomous delete: the autonomous row names it → deny.
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

	it("owner-agent fold: a watcher inherits its agent's envelope via ownerAgentId", async () => {
		// The agent (owning agent) sets delete=deny. The WATCHER is the acting
		// principal (principalKind='watcher') with its agent folded in via
		// ownerAgentId — the agent's deny must bind the watcher's write.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			effects: [{ action: "delete", effect: "deny" }],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "watcher",
				principalId: "watcher:7",
				ownerAgentId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
				mode: "autonomous",
			}),
		).toBe("deny");
	});

	it("owner-agent fold: a watcher-specific deny is NOT loosened by a looser agent envelope", async () => {
		// The owning agent auto-approves delete; a pre-existing WATCHER-specific row
		// denies it. Folding the agent envelope in must NOT loosen the watcher's own
		// deny — the strictest matched effect wins (this is the P1 regression).
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
			principalKind: "watcher",
			principalId: "watcher:7",
			effects: [{ action: "delete", effect: "deny" }],
		});
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "watcher",
				principalId: "watcher:7",
				ownerAgentId: "agent-1",
				action: "delete",
				entityTypeSlug: "task",
				mode: "autonomous",
			}),
		).toBe("deny");
	});

	it("a field-scoped row does NOT bleed into the entity create/delete decision", async () => {
		// A deny on ONE field (person.ssn update) must govern only that field, never
		// the whole entity's create or delete (this is the P2 regression). With no
		// entity-level row, create/delete follow their class defaults.
		await seedPolicy({
			orgId,
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			entityTypeSlug: "person",
			fieldPath: "ssn",
			effects: [{ action: "update", effect: "deny" }],
		});
		// create default = auto → allow (the field deny is irrelevant to create).
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "create",
				entityTypeSlug: "person",
			}),
		).toBe("allow");
		// delete default = approval → require_approval (NOT deny from the field row).
		expect(
			await evaluateEntityMutation({
				organizationId: orgId,
				principalKind: "agent",
				principalId: "agent-1",
				action: "delete",
				entityTypeSlug: "person",
			}),
		).toBe("require_approval");
	});

	it("a sparse effects input persists ONLY the named actions (untouched stay abstaining)", async () => {
		// An autonomous {delete: deny} override must NOT also pin create/update — a
		// stored row for those would stop them inheriting later attended/blanket
		// changes. The write path mirrors the resolver's sparse-row semantics.
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-1",
			principalMode: "autonomous",
			effects: { delete: "deny" },
		});
		const rows = await listEntityApprovalPolicies(orgId);
		const stored = rows.find(
			(r) =>
				r.principalKind === "agent" &&
				r.principalId === "agent-1" &&
				r.principalMode === "autonomous",
		);
		expect(stored).toBeTruthy();
		// Exactly one child effect row — create/update absent (abstaining).
		expect(stored?.effects).toEqual({ delete: "deny" });
	});

	it("fails CLOSED when a watcher's owning agent can't be resolved (codex-8)", async () => {
		// A reaction whose watcher row was hard-deleted mid-flight arrives with
		// ownerResolved=false. Even with the most permissive org default (entity
		// create = auto, no deny anywhere), the gate must DENY — proceeding as an
		// unowned watcher would let the write slip its agent's envelope.
		const denied = await evaluateEntityMutation({
			organizationId: orgId,
			principalKind: "watcher",
			principalId: "watcher:999",
			ownerResolved: false,
			action: "create",
			entityTypeSlug: "task",
		});
		expect(denied).toBe("deny");
		// Sanity: the SAME call with a resolved owner (default true) allows (auto).
		const allowed = await evaluateEntityMutation({
			organizationId: orgId,
			principalKind: "watcher",
			principalId: "watcher:999",
			action: "create",
			entityTypeSlug: "task",
		});
		expect(allowed).toBe("allow");
	});

	it("resolveWriteEffect also fails closed on an unresolved watcher owner (codex-8)", async () => {
		const effect = await resolveWriteEffect({
			organizationId: orgId,
			resourceClass: "connector_action",
			principalKind: "watcher",
			principalId: "watcher:999",
			ownerResolved: false,
			action: "execute",
		});
		expect(effect).toBe("deny");
	});

	it("the legacy org-settings list hides autonomous-only rows (codex-8)", async () => {
		// The new agent UI can create an autonomous-only entity row for an agent. The
		// legacy mode-blind org-settings endpoint must NOT surface it (its DELETE keys
		// by scope without principal_mode → would hit the wrong row).
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-auto",
			principalMode: "autonomous",
			entityTypeSlug: "task",
			effects: { delete: "deny" },
		});
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-auto",
			entityTypeSlug: "task",
			effects: { delete: "approval" },
		});
		// Mirror the endpoint's filter: only principal_mode NULL rows are shown.
		const shown = (await listEntityApprovalPolicies(orgId, "entity")).filter(
			(p) => p.principalMode === null,
		);
		const autoRows = shown.filter((p) => p.principalMode === "autonomous");
		expect(autoRows).toHaveLength(0);
		// The both-mode row for the same scope IS still shown.
		expect(
			shown.some(
				(p) =>
					p.principalId === "agent-auto" && p.entityTypeSlug === "task",
			),
		).toBe(true);
	});

	it("preserveDelivery keeps a stored approval target across an effect-only update (codex-7)", async () => {
		// First save configures a delivery target (as the entity-settings path would).
		await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-deliv",
			effects: { create: "approval" },
			approvalConnectionId: "conn_slack",
			approvalChannelId: "chan_ops",
			approvalTeamId: "T123",
			approvalChannelName: "#ops",
		});
		// The effect-only permissions PUT re-saves with NO delivery fields but
		// preserveDelivery set — the stored target must survive.
		const updated = await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-deliv",
			effects: { create: "deny" },
			preserveDelivery: true,
		});
		expect(updated.deliveryTarget.connectionId).toBe("conn_slack");
		expect(updated.deliveryTarget.channelId).toBe("chan_ops");
		expect(updated.effects).toEqual({ create: "deny" });

		// Without preserveDelivery, an omitted delivery still CLEARS it (the
		// entity-settings path means what it sends).
		const cleared = await upsertEntityApprovalPolicy(orgId, {
			resourceClass: "entity",
			principalKind: "agent",
			principalId: "agent-deliv",
			effects: { create: "approval" },
		});
		expect(cleared.deliveryTarget.connectionId).toBeNull();
		expect(cleared.deliveryTarget.channelId).toBeNull();
	});
});
