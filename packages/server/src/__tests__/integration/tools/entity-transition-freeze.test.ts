import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
};

function humanCtx(orgId: string, userId: string): AuthContext {
	return {
		organizationId: orgId,
		tokenOrganizationId: orgId,
		userId,
		memberRole: "owner",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgId}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	};
}

function agentCtx(orgId: string, userId: string, agentId = "test-agent-1"): AuthContext {
	return { ...humanCtx(orgId, userId), agentId, requestedAgentId: agentId };
}

const TRANSITION_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string" },
		notes: { type: "string" },
	},
	additionalProperties: true,
	"x-transitions": {
		field: "status",
		allowed: { draft: ["issued", "cancelled"], issued: ["posted"], posted: [] },
		frozen_from: "issued",
	},
} as const;

type UpdateResult = {
	approval_queued?: boolean;
	approval_run_id?: number;
	applied_fields?: string[];
	blocked_fields?: string[];
};

async function setEntityTypeSchema(
	orgId: string,
	slug: string,
	schema: Record<string, unknown> | null,
): Promise<void> {
	const sql = getTestDb();
	await sql`
		UPDATE entity_types
		SET metadata_schema = ${schema ? sql.json(schema) : null}
		WHERE organization_id = ${orgId}
		  AND slug = ${slug}
	`;
}

async function seedInvoice(orgId: string, userId: string, status: string): Promise<number> {
	const sql = getTestDb();
	const entity = await createTestEntity({
		name: `Invoice ${status}`,
		entity_type: "invoice",
		organization_id: orgId,
		created_by: userId,
	});
	await setEntityTypeSchema(orgId, "invoice", TRANSITION_SCHEMA);
	await sql`
		UPDATE entities
		SET metadata = ${sql.json({ status, notes: `${status}-notes` })}
		WHERE id = ${entity.id}
	`;
	return entity.id;
}

async function manageEntityUpdate(
	ctx: AuthContext,
	entityId: number,
	metadata: Record<string, unknown>,
): Promise<UpdateResult> {
	return executeTool(
		"manage_entity",
		{ action: "update", entity_id: entityId, metadata },
		TEST_ENV,
		ctx,
	) as Promise<UpdateResult>;
}

async function seedRelationshipType(orgId: string, slug: string): Promise<void> {
	const sql = getTestDb();
	await sql`
		INSERT INTO entity_relationship_types
			(slug, name, description, organization_id, is_symmetric, status, created_at, updated_at)
		VALUES
			(${slug}, ${slug}, 'freeze test edge', ${orgId}, false, 'active',
			 current_timestamp, current_timestamp)
		ON CONFLICT (organization_id, slug) WHERE status = 'active' DO NOTHING
	`;
}

/** A plain entity with no transition rules, used as the other end of an edge. */
async function seedCustomer(orgId: string, userId: string): Promise<number> {
	const entity = await createTestEntity({
		name: `Customer ${Math.random().toString(36).slice(2, 8)}`,
		entity_type: "customer",
		organization_id: orgId,
		created_by: userId,
	});
	return entity.id;
}

async function manageEntityLink(
	ctx: AuthContext,
	fromId: number,
	toId: number,
	slug: string,
): Promise<{ relationship?: { id: number } }> {
	return executeTool(
		"manage_entity",
		{
			action: "link",
			from_entity_id: fromId,
			to_entity_id: toId,
			relationship_type_slug: slug,
		},
		TEST_ENV,
		ctx,
	) as Promise<{ relationship?: { id: number } }>;
}

async function liveEdgeCount(fromId: number): Promise<number> {
	const rows = await getTestDb()`
		SELECT id FROM entity_relationships
		WHERE from_entity_id = ${fromId} AND deleted_at IS NULL
	`;
	return rows.length;
}

async function approvalCount(orgId: string): Promise<number> {
	const rows = await getTestDb()`
		SELECT id FROM runs
		WHERE organization_id = ${orgId}
		  AND run_type = 'internal'
		  AND action_key = 'entity_field_change'
		  AND approval_status = 'pending'
	`;
	return rows.length;
}

async function entityMetadata(entityId: number): Promise<Record<string, unknown>> {
	const rows = await getTestDb()`SELECT metadata FROM entities WHERE id = ${entityId}`;
	return rows[0]?.metadata as Record<string, unknown>;
}

describe("entity transition freeze", () => {
	let orgId: string;
	let ownerUserId: string;
	let ownerCtx: AuthContext;
	let ownerAgentCtx: AuthContext;

	beforeAll(async () => {
		await initWorkspaceProvider();
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Invoice Freeze Org" });
		orgId = org.id;
		const owner = await createTestUser({ email: "invoice-owner@test.com" });
		ownerUserId = owner.id;
		await addUserToOrganization(owner.id, org.id, "owner");
		await createTestAgent({
			organizationId: org.id,
			agentId: "test-agent-1",
			ownerUserId: owner.id,
		});
		ownerCtx = humanCtx(org.id, owner.id);
		ownerAgentCtx = agentCtx(org.id, owner.id);
	});

	it("denies an agent edit on a posted invoice", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "posted");
		await expect(
			manageEntityUpdate(ownerAgentCtx, entityId, { notes: "agent-edit" }),
		).rejects.toThrow(/frozen in state "posted"/i);
	});

	it("denies a human edit on a posted invoice", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "posted");
		await expect(
			manageEntityUpdate(ownerCtx, entityId, { notes: "human-edit" }),
		).rejects.toThrow(/frozen in state "posted"/i);
	});

	it("allows a human edit on a draft invoice without queuing approval", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "draft");
		const result = await manageEntityUpdate(ownerCtx, entityId, {
			notes: "draft-edit",
		});
		expect((await entityMetadata(entityId)).notes).toBe("draft-edit");
		expect(result.approval_queued).toBeFalsy();
		expect(await approvalCount(orgId)).toBe(0);
	});

	it("allows a human to edit their own draft field again without queuing approval", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "draft");
		await manageEntityUpdate(ownerCtx, entityId, { notes: "first-pass" });
		const result = await manageEntityUpdate(ownerCtx, entityId, {
			notes: "second-pass",
		});
		expect((await entityMetadata(entityId)).notes).toBe("second-pass");
		expect(result.approval_queued).toBeFalsy();
		expect(await approvalCount(orgId)).toBe(0);
	});

	it("denies an illegal draft to posted transition", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "draft");
		await expect(
			manageEntityUpdate(ownerCtx, entityId, { status: "posted" }),
		).rejects.toThrow(/cannot transition status from "draft" to "posted"/i);
	});

	it("allows a draft to issued transition", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "draft");
		await manageEntityUpdate(ownerCtx, entityId, { status: "issued" });
		expect((await entityMetadata(entityId)).status).toBe("issued");
	});

	it("allows a frozen invoice to advance along a legal transition", async () => {
		// `frozen_from: "issued"` freezes every FIELD from `issued` onward, but the
		// state field itself must stay movable or the document strands one step
		// short of terminal and can never be posted.
		const entityId = await seedInvoice(orgId, ownerUserId, "issued");
		await manageEntityUpdate(ownerCtx, entityId, { status: "posted" });
		expect((await entityMetadata(entityId)).status).toBe("posted");
	});

	it("still seals a terminal state against its own state field", async () => {
		// `allowed.posted` is empty, so the exemption above must not let a posted
		// invoice transition anywhere — the freeze exemption is not an escape.
		const entityId = await seedInvoice(orgId, ownerUserId, "posted");
		await expect(
			manageEntityUpdate(ownerCtx, entityId, { status: "draft" }),
		).rejects.toThrow(/cannot transition status from "posted" to "draft"/i);
	});

	it("denies a field edit that rides along with a legal transition", async () => {
		// The exemption covers the state field ONLY. Bundling a real edit with a
		// legal transition must not smuggle the edit past the freeze.
		const entityId = await seedInvoice(orgId, ownerUserId, "issued");
		await expect(
			manageEntityUpdate(ownerCtx, entityId, {
				status: "posted",
				notes: "smuggled",
			}),
		).rejects.toThrow(/frozen in state "issued"/i);
	});

	it("does not apply an approved proposal after the invoice freezes", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "draft");
		await manageEntityUpdate(ownerCtx, entityId, { notes: "human-owned" });
		const pending = await manageEntityUpdate(ownerAgentCtx, entityId, {
			notes: "agent-proposal",
		});
		expect(pending.approval_queued).toBe(true);
		const runId = pending.approval_run_id;
		expect(runId).toBeTypeOf("number");

		const sql = getTestDb();
		await sql`
			UPDATE entities
			SET metadata = ${sql.json({ status: "posted", notes: "human-owned" })}
			WHERE id = ${entityId}
		`;

		await executeTool(
			"manage_operations",
			{ action: "approve", run_id: runId },
			TEST_ENV,
			ownerCtx,
		);
		expect((await entityMetadata(entityId)).notes).toBe("human-owned");

		const runs = await getTestDb()`
			SELECT approval_status, status, error_message FROM runs WHERE id = ${runId}
		`;
		expect(runs[0]?.approval_status).toBe("pending");
		expect(runs[0]?.status).toBe("pending");
	});

	it("leaves entity types without x-transitions unaffected", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "posted");
		await setEntityTypeSchema(orgId, "invoice", {
			type: "object",
			properties: { status: { type: "string" }, notes: { type: "string" } },
			additionalProperties: true,
		});
		await manageEntityUpdate(ownerAgentCtx, entityId, { notes: "unfrozen-now" });
		expect((await entityMetadata(entityId)).notes).toBe("unfrozen-now");
	});

	// --- The freeze must cover the GRAPH, not just the metadata --------------
	//
	// Before the edge paths were gated, a posted invoice's fields were sealed
	// while `entity_relationships` stayed wide open — so the document could be
	// re-pointed at a different quote or customer with no gate at all.

	it("denies linking FROM a posted invoice", async () => {
		const invoiceId = await seedInvoice(orgId, ownerUserId, "posted");
		const customerId = await seedCustomer(orgId, ownerUserId);
		await seedRelationshipType(orgId, "invoice_customer");
		await expect(
			manageEntityLink(ownerCtx, invoiceId, customerId, "invoice_customer"),
		).rejects.toThrow(/frozen in state "posted"/i);
		expect(await liveEdgeCount(invoiceId)).toBe(0);
	});

	it("denies linking FROM a posted invoice for an agent too", async () => {
		const invoiceId = await seedInvoice(orgId, ownerUserId, "posted");
		const customerId = await seedCustomer(orgId, ownerUserId);
		await seedRelationshipType(orgId, "invoice_customer");
		await expect(
			manageEntityLink(ownerAgentCtx, invoiceId, customerId, "invoice_customer"),
		).rejects.toThrow(/frozen in state "posted"/i);
		expect(await liveEdgeCount(invoiceId)).toBe(0);
	});

	it("allows linking FROM a draft invoice", async () => {
		const invoiceId = await seedInvoice(orgId, ownerUserId, "draft");
		const customerId = await seedCustomer(orgId, ownerUserId);
		await seedRelationshipType(orgId, "invoice_customer");
		await manageEntityLink(ownerCtx, invoiceId, customerId, "invoice_customer");
		expect(await liveEdgeCount(invoiceId)).toBe(1);
	});

	// Being POINTED AT is not a mutation of the target. A payment applied to a
	// posted invoice is the ordinary accounting flow and must keep working.
	it("allows linking INTO a posted invoice", async () => {
		const invoiceId = await seedInvoice(orgId, ownerUserId, "posted");
		const paymentId = await seedCustomer(orgId, ownerUserId);
		await seedRelationshipType(orgId, "payment_invoice");
		await manageEntityLink(ownerCtx, paymentId, invoiceId, "payment_invoice");
		expect(await liveEdgeCount(paymentId)).toBe(1);
	});

	it("denies unlinking an edge once its source invoice is posted", async () => {
		const invoiceId = await seedInvoice(orgId, ownerUserId, "draft");
		const customerId = await seedCustomer(orgId, ownerUserId);
		await seedRelationshipType(orgId, "invoice_customer");
		const created = await manageEntityLink(
			ownerCtx,
			invoiceId,
			customerId,
			"invoice_customer",
		);
		const relationshipId = Number(created.relationship?.id);
		expect(relationshipId).toBeGreaterThan(0);

		await getTestDb()`
			UPDATE entities SET metadata = ${getTestDb().json({ status: "posted" })}
			WHERE id = ${invoiceId}
		`;

		await expect(
			executeTool(
				"manage_entity",
				{ action: "unlink", relationship_id: relationshipId },
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/frozen in state "posted"/i);
		expect(await liveEdgeCount(invoiceId)).toBe(1);
	});

	it("denies rewriting edge metadata once its source invoice is posted", async () => {
		const invoiceId = await seedInvoice(orgId, ownerUserId, "draft");
		const customerId = await seedCustomer(orgId, ownerUserId);
		await seedRelationshipType(orgId, "invoice_customer");
		const created = await manageEntityLink(
			ownerCtx,
			invoiceId,
			customerId,
			"invoice_customer",
		);
		const relationshipId = Number(created.relationship?.id);

		await getTestDb()`
			UPDATE entities SET metadata = ${getTestDb().json({ status: "posted" })}
			WHERE id = ${invoiceId}
		`;

		await expect(
			executeTool(
				"manage_entity",
				{
					action: "update_link",
					relationship_id: relationshipId,
					metadata: { tampered: true },
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/frozen in state "posted"/i);
	});

	// An entity type with no `x-transitions` rule must be entirely unaffected —
	// the gate is opt-in per type, and infrastructure edges must not regress.
	it("leaves edges on an unruled entity type alone", async () => {
		const a = await seedCustomer(orgId, ownerUserId);
		const b = await seedCustomer(orgId, ownerUserId);
		await seedRelationshipType(orgId, "related_to");
		await manageEntityLink(ownerCtx, a, b, "related_to");
		expect(await liveEdgeCount(a)).toBe(1);
	});

	it("changes behavior immediately when the schema rule changes", async () => {
		const entityId = await seedInvoice(orgId, ownerUserId, "issued");
		await expect(
			manageEntityUpdate(ownerCtx, entityId, { notes: "blocked-while-issued" }),
		).rejects.toThrow(/frozen in state "issued"/i);
		await setEntityTypeSchema(orgId, "invoice", {
			...TRANSITION_SCHEMA,
			"x-transitions": {
				...TRANSITION_SCHEMA["x-transitions"],
				frozen_from: "posted",
			},
		});
		await manageEntityUpdate(ownerCtx, entityId, { notes: "allowed-after-change" });
		expect((await entityMetadata(entityId)).notes).toBe("allowed-after-change");
	});
});
