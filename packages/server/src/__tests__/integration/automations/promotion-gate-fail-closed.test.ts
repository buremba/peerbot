/**
 * The mutation gate must fail CLOSED inside automation promotion: a `deny` from
 * ANY interceptor (e.g. a future quota gate) means the write does not happen —
 * it must never degrade into "create anyway" or "apply fields anyway", and a
 * denied create must not queue an approval card either.
 *
 * Drives `promoteAutomationEntityOutput` directly (inside a transaction, like
 * complete_window does) with a test interceptor registered into the gate.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	__resetMutationGateForTests,
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
	// A REAL automation (with an owning agent) — the gate resolves automations.agent_id and
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
    INSERT INTO automations (id, organization_id, slug, name, agent_id, created_by, automation_group_id, created_at, updated_at)
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
	});
});
