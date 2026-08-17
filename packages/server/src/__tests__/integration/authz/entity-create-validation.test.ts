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
import type { ToolContext } from "../../../tools/registry";
import { createEntity, updateEntity } from "../../../utils/entity-management";
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

const TEST_ENV = {} as Env;
let invoiceCompiled: string;

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

async function seedOrg() {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Create Validation" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema,
                              rules_compiled, created_at, updated_at)
    VALUES (${org.id}, 'invoice', 'invoice', ${sql.json({ type: "object" })},
            ${invoiceCompiled}, current_timestamp, current_timestamp)
  `;
	return { org, user, agent };
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
		invoiceCompiled = await compileEntityRule(INVOICE_RULE);
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
});
