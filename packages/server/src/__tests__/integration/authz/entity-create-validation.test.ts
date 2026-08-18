/**
 * Creates reach the validation seam.
 *
 * This file began as a spike proving the opposite. `insertEntityRow` never
 * called the validator, so every state rule was trivially routable: an agent
 * denied a `draft -> posted` update simply created the document already posted,
 * and "posting requires an e-invoice UUID" only ever bit someone who took a
 * legal draft and edited it — i.e. someone already following the rules.
 *
 * The fix was the same brand the update path already carried, applied to the
 * second writer, so a caller that forgets to validate a create fails to compile.
 * The cases below are the regression test for that: the first asserts the create
 * is now DENIED, and the second is the contrast that pins the rule as the cause
 * rather than some unrelated error.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { applyEntityChangeProposal } from "../../../tools/admin/entity-field-approval";
import type { ToolContext } from "../../../tools/registry";
import { createEntity, updateEntity } from "../../../utils/entity-management";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

/**
 * `posted` is terminal and frozen. Reaching it legally means passing through
 * `issued`, and `einvoice_uuid` is only writable on the exit INTO `posted`.
 *
 * The `op === "create"` branch is the whole point: a create is an update from
 * nothing, so `committed` is empty and the rule decides what a row is allowed to
 * be born as. Without that branch the transition table below governs edits only.
 */
const INVOICE_RULE = `
const ALLOWED = { draft: ["issued"], issued: ["posted"], posted: [] };

export default (row) => {
  if (row.op === "create") {
    if (row.next.status !== "draft") {
      row.deny("an invoice is created in draft, not " + row.next.status);
    }
    return;
  }
  const from = row.committed.status;
  const to = row.next.status;
  if (from !== to && !(ALLOWED[from] || []).includes(to)) {
    row.deny("cannot move " + from + " -> " + to);
  }
  if (to === "posted" && !row.next.einvoice_uuid) {
    row.deny("posting requires an e-invoice UUID");
  }
};
`;

/**
 * A rule that holds a CREATE for review rather than rejecting it. The row does
 * not exist yet, so there is nothing to hold fields against — the whole
 * proposed row is either created or it is not.
 */
const BIG_INVOICE_RULE = `
export default (row) => {
  if (row.op === "create" && row.next.amount > 50000) {
    row.escalate(["amount"], "a new invoice over 50k needs sign-off");
  }
};
`;

const TEST_ENV = {} as Env;

/** `executeTool` goes through the real access-controlled path, so it needs a real env. */
const TOOL_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
} as Env;

let invoiceCompiled: string;
let bigInvoiceCompiled: string;

function ctxFor(
	organizationId: string,
	opts: { userId?: string | null; agentId?: string | null },
): ToolContext {
	return {
		organizationId,
		userId: opts.userId ?? null,
		memberRole: "owner",
		agentId: opts.agentId ?? null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		scopedToOrg: true,
		allowCrossOrg: false,
	} as unknown as ToolContext;
}

async function seedOrg(rules: string = invoiceCompiled) {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Create Validation" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema,
                              rules_compiled, created_at, updated_at)
    VALUES (${org.id}, 'invoice', 'invoice', ${sql.json({ type: "object" })},
            ${rules}, current_timestamp, current_timestamp)
  `;
	return { org, user, agent };
}

/** Agent auth context — an agent run, so a hold routes to a human. */
function agentAuthCtx(orgId: string, userId: string, agentId: string): AuthContext {
	return {
		organizationId: orgId,
		tokenOrganizationId: orgId,
		userId,
		memberRole: "owner",
		agentId,
		requestedAgentId: agentId,
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

async function statusOf(id: number): Promise<unknown> {
	const sql = getTestDb();
	const rows = await sql<{ metadata: unknown }[]>`
    SELECT metadata FROM entities WHERE id = ${id}`;
	const raw = rows[0].metadata;
	const md = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
		string,
		unknown
	>;
	return md.status;
}

async function countInvoices(organizationId: string): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM entities WHERE organization_id = ${organizationId}
  `;
	return Number(rows[0].n);
}

describe("creates reach the validation seam", () => {
	beforeAll(async () => {
		// `queue()` builds an approval URL, which needs the workspace provider.
		await initWorkspaceProvider();
		[invoiceCompiled, bigInvoiceCompiled] = await Promise.all([
			compileEntityRule(INVOICE_RULE),
			compileEntityRule(BIG_INVOICE_RULE),
		]);
	}, 60_000);

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("denies an invoice born DIRECTLY in the terminal frozen state", async () => {
		const { org, user } = await seedOrg();

		await expect(
			createEntity({
				entity_type: "invoice",
				name: "INV-BORN-POSTED",
				organization_id: org.id,
				created_by: user.id,
				metadata: { status: "posted", einvoice_uuid: "uuid-1" },
			} as Parameters<typeof createEntity>[0]),
		).rejects.toThrow(/an invoice is created in draft, not posted/);

		// The whole insert rolled back — no half-created row behind the denial.
		expect(await countInvoices(org.id)).toBe(0);
	}, 60_000);

	it("permits the legal create and still denies the same end state by update", async () => {
		const { org, user, agent } = await seedOrg();

		const invoice = await createEntity({
			entity_type: "invoice",
			name: "INV-LEGAL-DRAFT",
			organization_id: org.id,
			created_by: user.id,
			metadata: { status: "draft", einvoice_uuid: null },
		} as Parameters<typeof createEntity>[0]);
		expect(await statusOf(invoice.id)).toBe("draft");

		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { status: "posted", einvoice_uuid: "uuid-1" } },
				TEST_ENV,
				ctxFor(org.id, { userId: user.id, agentId: agent.agentId }),
			),
		).rejects.toThrow(/cannot move draft -> posted/);

		// And the row is untouched — the deny rolled the write back.
		expect(await statusOf(invoice.id)).toBe("draft");
	}, 60_000);

	it("routes an escalating CREATE into an approval card instead of throwing", async () => {
		const { org, user, agent } = await seedOrg(bigInvoiceCompiled);

		// Through `executeTool`, the real access-controlled path — the routing
		// lives in the tool handler, so calling `createEntity` directly would
		// only ever observe the throw.
		const result = (await executeTool(
			"manage_entity",
			{
				action: "create",
				entity_type: "invoice",
				name: "INV-BIG",
				metadata: { status: "draft", amount: 90000 },
			},
			TOOL_ENV,
			agentAuthCtx(org.id, user.id, agent.agentId),
		)) as {
			approval_queued?: boolean;
			approval_run_id?: number;
			approval_proposal?: Record<string, unknown>;
		};

		expect(result.approval_queued).toBe(true);
		expect(result.approval_run_id).toBeGreaterThan(0);

		// Nothing was created. A create that needs review must leave no row
		// behind — there is no half-created state to reconcile later.
		expect(await countInvoices(org.id)).toBe(0);
	}, 60_000);

	it("creates the row when the escalated card is APPROVED", async () => {
		const { org, user, agent } = await seedOrg(bigInvoiceCompiled);
		const authCtx = agentAuthCtx(org.id, user.id, agent.agentId);

		const held = (await executeTool(
			"manage_entity",
			{
				action: "create",
				entity_type: "invoice",
				name: "INV-BIG",
				metadata: { status: "draft", amount: 90000 },
			},
			TOOL_ENV,
			authCtx,
		)) as { approval_queued?: boolean; approval_proposal?: Record<string, unknown> };
		expect(held.approval_queued).toBe(true);

		// Approving re-runs the SAME rule against the SAME proposed row. Without
		// the approved-write signal it escalates again and throws, so the card
		// could never be cleared — the dead end the update path already had.
		await applyEntityChangeProposal(
			{
				operation: "create",
				entity_data: {
					entity_type: "invoice",
					name: "INV-BIG",
					metadata: { status: "draft", amount: 90000 },
				},
				proposal: held.approval_proposal ?? {},
				escalated_fields: ["amount"],
			} as Parameters<typeof applyEntityChangeProposal>[0],
			{ ...authCtx, userId: user.id } as unknown as ToolContext,
			TOOL_ENV,
			getTestDb(),
		);

		expect(await countInvoices(org.id)).toBe(1);
	}, 60_000);

	it("still DENIES a create outright — approval is not a way around a deny", async () => {
		const { org, user, agent } = await seedOrg();

		// The card path exists for `escalate` only. A rule that denies a create
		// gets an error, not a human to ask.
		await expect(
			executeTool(
				"manage_entity",
				{
					action: "create",
					entity_type: "invoice",
					name: "INV-BORN-POSTED",
					metadata: { status: "posted", einvoice_uuid: "uuid-1" },
				},
				TOOL_ENV,
				agentAuthCtx(org.id, user.id, agent.agentId),
			),
		).rejects.toThrow(/an invoice is created in draft, not posted/);

		expect(await countInvoices(org.id)).toBe(0);
	}, 60_000);
});
