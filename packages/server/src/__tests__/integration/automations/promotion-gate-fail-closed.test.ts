/**
 * The mutation gate must fail CLOSED inside automation promotion: a `deny` from
 * ANY interceptor (e.g. a future quota gate) means the write does not happen —
 * it must never degrade into "create anyway" or "apply fields anyway", and a
 * denied create must not queue an approval card either.
 *
 * Drives `promoteAutomationEntityOutput` directly (inside a transaction, like
 * complete_window does) with a test interceptor registered into the gate.
 */

import { ApprovalAttribution } from "@lobu/core/contracts/interaction-envelope";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	__resetMutationGateForTests,
	deferEntityCreate,
	registerMutationInterceptor,
} from "../../../authz/entity-mutation-gate";
import type { DbClient } from "../../../db/client";
import { promoteAutomationEntityOutput } from "../../../utils/promote-keyed-entities";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestEntity,
	createTestOrganization,
} from "../../setup/test-fixtures";
import { initWorkspaceProvider } from "../../../workspace";

const ENTITY_OUTPUT = {
	entity: "topic",
	key: ["category", "name"],
};

function extracted(severity: string) {
	return {
		problems: [
			{
				category: "Stability",
				name: "App Crashes",
				severity,
			},
		],
	};
}

async function setup() {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Gate Fail-Closed Org" });
	const parent = await createTestEntity({
		name: "Parent Brand",
		organization_id: org.id,
	});
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${org.id}, 'topic', 'Topic', current_timestamp, current_timestamp)
    ON CONFLICT DO NOTHING
  `;
	const [member] = await sql`
    SELECT "userId" FROM "member" WHERE "organizationId" = ${org.id} LIMIT 1
  `;
	const createdBy = (member?.userId as string) ?? "test-seed-user";
	// A REAL automation (with an owning agent) — the gate resolves automations.managed_agent_id and
	// FAILS CLOSED if the automation row is missing, so a fake id would now deny every
	// write. We exercise the interceptor fail-closed here, not owner-resolution.
	const agent = await createTestAgent({
		organizationId: org.id,
		ownerUserId: createdBy,
	});
	// automations.automation_group_id is NOT NULL and self-references the row (the CRUD sets
	// it = the automation id); id is serial. Grab the next id first so both match.
	const [{ nextid }] = await sql<{ nextid: number }>`
    SELECT nextval('automations_id_seq') AS nextid
  `;
	const automationId = Number(nextid);
	await sql`
    INSERT INTO automations (id, organization_id, slug, name, managed_agent_id, created_by, automation_group_id, created_at, updated_at)
    VALUES (${automationId}, ${org.id}, 'gate-fail-closed', 'Gate Fail Closed', ${agent.agentId}, ${createdBy}, ${automationId}, NOW(), NOW())
  `;
	const [run] = await sql<{ id: number }[]>`
		INSERT INTO runs (organization_id, automation_id, run_type, status)
		VALUES (${org.id}, ${automationId}, 'automation', 'completed') RETURNING id
	`;
	return { sql, orgId: org.id, parentId: parent.id, createdBy, automationId, runId: run.id };
}

async function promote(
	ctx: Awaited<ReturnType<typeof setup>>,
	severity: string,
) {
	return ctx.sql.begin(async (tx) =>
		promoteAutomationEntityOutput({
			tx: tx as unknown as DbClient,
			extractedData: extracted(severity),
			outputName: "problems",
			output: ENTITY_OUTPUT,
			automationId: ctx.automationId,
			organizationId: ctx.orgId,
			runId: ctx.runId,
			parentEntityId: ctx.parentId,
			createdBy: ctx.createdBy,
			validContentIds: new Set<number>(),
		}),
	);
}

async function promotedIdentities(ctx: Awaited<ReturnType<typeof setup>>) {
	return ctx.sql`
    SELECT ei.entity_id, e.metadata
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = ${ctx.orgId} AND ei.namespace = 'automation_key'
  `;
}

describe("mutation gate fail-closed in automation promotion", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		await cleanupTestDatabase();
	});

	afterEach(() => {
		__resetMutationGateForTests();
	});

	it("a denied create neither creates the entity nor queues an approval", async () => {
		const ctx = await setup();
		registerMutationInterceptor({
			name: "test-deny-create",
			evaluate: async (req) =>
				req.action === "create"
					? { outcome: "deny", reason: "quota exceeded" }
					: null,
		});

		const result = await promote(ctx, "low");

		expect(result.promoted).toBe(0);
		expect(result.created).toBe(0);
		// Fail-closed: a deny is NOT a defer — no approval card is queued.
		expect(result.deferred).toHaveLength(0);
		expect(await promotedIdentities(ctx)).toHaveLength(0);
	});

	/**
	 * The HANDLE on a row that was never written. `promote-keyed-entities.test.ts`
	 * already proves a policy-denied create reaches the persisted change set with
	 * `source: 'policy'` and a reason; what it does not pin is the identity of that
	 * record — `entityId: 0` and the proposed name. Both are load-bearing:
	 * complete-window links the change set with `filter((id) => id > 0)`, so a
	 * refused create that reported any other id would link the timeline to an
	 * unrelated entity, and the name is the only thing left to read it back by.
	 *
	 * Also pins the record across a move: this refusal used to be re-derived at the
	 * caller from the type-wide gate decision, and is now returned by
	 * `upsertKeyedEntity` like every other refusal.
	 */
	it("a denied create records the policy refusal in the run's change set", async () => {
		const ctx = await setup();
		registerMutationInterceptor({
			name: "test-deny-create-record",
			evaluate: async (req) =>
				req.action === "create"
					? { outcome: "deny", reason: "quota exceeded" }
					: null,
		});

		const result = await promote(ctx, "low");

		expect(result.changes).toHaveLength(1);
		// A refused create has no row, so it carries no id and is recorded under
		// the name the automation proposed.
		expect(result.changes[0].entityId).toBe(0);
		expect(result.changes[0]).toMatchObject({
			kind: "denied",
			name: "Stability · App Crashes",
			denied: { source: "policy", reason: "quota exceeded" },
		});
	});

	/**
	 * The negative that keeps the create branch honest. `defer` and `deny` are both
	 * "not allow", and both block the inline insert — but only one is a refusal.
	 * Reporting a deferral as `denied` SWALLOWS the card: the caller records the
	 * refusal and `continue`s before it reaches the carding branch, so the row is
	 * marked rejected and the approval it was owed is never queued.
	 */
	it("a DEFERRED create is carded, not recorded as a refusal", async () => {
		const ctx = await setup();
		registerMutationInterceptor({
			name: "test-defer-create-record",
			evaluate: async (req) =>
				req.action === "create"
					? {
							outcome: "defer",
							deferred: deferEntityCreate({
								entityData: { entity_type: "topic", name: "App Crashes" },
								proposal: {},
								attribution: ApprovalAttribution.Automation,
							}),
						}
					: null,
		});

		const result = await promote(ctx, "low");

		expect(result.created).toBe(0);
		expect(result.deferred).toHaveLength(1);
		expect(result.changes.filter((c) => c.kind === "denied")).toHaveLength(0);
		expect(await promotedIdentities(ctx)).toHaveLength(0);
	});

	it("a denied update applies no fields (row skipped, window not poisoned)", async () => {
		const ctx = await setup();

		// Seed the entity with the gate in its default (allow) state.
		const first = await promote(ctx, "low");
		expect(first.created).toBe(1);
		const [seeded] = await promotedIdentities(ctx);
		expect((seeded.metadata as Record<string, unknown>).severity).toBe("low");

		// A later interceptor denies updates outright.
		registerMutationInterceptor({
			name: "test-deny-update",
			evaluate: async (req) =>
				req.action === "update"
					? { outcome: "deny", reason: "rate limited" }
					: null,
		});

		// The denied row is skipped (savepoint-isolated) — promotion itself
		// resolves without throwing and applies NOTHING.
		const second = await promote(ctx, "critical");
		expect(second.promoted).toBe(0);
		expect(second.deferred).toHaveLength(0);

		const [after] = await promotedIdentities(ctx);
		expect((after.metadata as Record<string, unknown>).severity).toBe("low");
		expect(second.changes).toHaveLength(1);
		expect(second.changes[0]).toMatchObject({
			kind: "denied",
			denied: { source: "policy", reason: "rate limited" },
		});
	});
});
