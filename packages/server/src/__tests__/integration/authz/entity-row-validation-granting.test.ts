/**
 * The GRANTING split of the entity-row validation seam.
 *
 * `validateEntityRowPatch` / `validateEntityRowInsert` WAIVE NOTHING — an
 * escalate always throws. Only the `*GrantingApprovedFields` entry points take
 * the field list a human approved, and only they can let an escalation through.
 * This file proves both halves end to end against a real type rule: a covered
 * grant lands, an uncovered grant throws naming the gap, and the ordinary
 * validator cannot be used to skip at all.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import {
	validateEntityRowPatch,
	validateEntityRowPatchGrantingApprovedFields,
} from "../../../authz/entity-row-validation";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import {
	createEntity,
	mergeEntityFields,
	patchEntityRows,
	updateEntity,
} from "../../../utils/entity-management";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

/** Any amount above 50k needs sign-off, on both the create and update paths. */
const ESCALATE_RULE = `
export default (row) => {
  if (row.op === "create") {
    if (row.next.status !== "draft") {
      row.deny("an invoice is created in draft, not " + row.next.status);
    }
    if (row.next.amount > 50000) {
      row.escalate(["amount"], "an invoice over 50k needs sign-off");
    }
    return;
  }
  if (row.changed("status") && !( { draft: ["issued"], issued: ["posted"], posted: [] }[row.committed.status] || [] ).includes(row.next.status)) {
    row.deny("cannot move " + row.committed.status + " -> " + row.next.status);
  }
  if (row.next.amount > 50000) {
    row.escalate(["amount"], "an invoice over 50k needs sign-off");
  }
};
`;

const TEST_ENV = {} as Env;

let escalateCompiled: string;

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

async function seedType(
	organizationId: string,
	slug: string,
	rulesCompiled: string | null,
) {
	const sql = getTestDb();
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema,
                              rules_compiled, created_at, updated_at)
    VALUES (${organizationId}, ${slug}, ${slug}, ${sql.json({ type: "object" })},
            ${rulesCompiled}, current_timestamp, current_timestamp)
  `;
}

async function readMetadata(id: number): Promise<Record<string, unknown>> {
	const sql = getTestDb();
	const rows = await sql<{ metadata: unknown }[]>`
    SELECT metadata FROM entities WHERE id = ${id}
  `;
	const raw = rows[0].metadata;
	return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
		string,
		unknown
	>;
}

async function seedInvoice(
	status: "draft" | "issued",
	rule: string | null = escalateCompiled,
) {
	const org = await createTestOrganization({ name: `Grant ${status}` });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	await seedType(org.id, "invoice", rule);

	const invoice = await createEntity({
		entity_type: "invoice",
		name: "INV-1",
		organization_id: org.id,
		created_by: user.id,
		metadata: { status: "draft", amount: 100 },
	} as Parameters<typeof createEntity>[0]);

	if (status === "issued") {
		await updateEntity(
			invoice.id,
			{ metadata: { status: "issued" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);
	}
	return { org, user, agent, invoice };
}

describe("granting validator split — only the apply path may waive", () => {
	beforeAll(async () => {
		escalateCompiled = await compileEntityRule(ESCALATE_RULE);
	}, 60_000);

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("ordinary validator waives nothing: an escalate throws without any approval list", async () => {
		const { invoice } = await seedInvoice("issued");

		const sql = getTestDb();
		await expect(
			sql.begin(async (tx) => {
				const patch = await validateEntityRowPatch({
					tx,
					ids: [invoice.id],
					patch: { metadata: { amount: 99_999 } },
				});
				await patchEntityRows({ tx, ids: [invoice.id], patch });
			}),
		).rejects.toThrow(/approval required for amount/);
		expect((await readMetadata(invoice.id)).amount).toBe(100);
	}, 60_000);

	it("covered grant waives exactly the fields on the card", async () => {
		const { invoice } = await seedInvoice("issued");

		const sql = getTestDb();
		await sql.begin(async (tx) => {
			const patch = await validateEntityRowPatchGrantingApprovedFields({
				tx,
				ids: [invoice.id],
				patch: { metadata: { amount: 99_999 } },
				approvedFields: ["amount"],
			});
			await patchEntityRows({ tx, ids: [invoice.id], patch });
		});

		expect((await readMetadata(invoice.id)).amount).toBe(99_999);
	}, 60_000);

	it("uncovered grant throws naming what was approved", async () => {
		const { invoice } = await seedInvoice("issued");

		const sql = getTestDb();
		await expect(
			sql.begin(async (tx) => {
				const patch = await validateEntityRowPatchGrantingApprovedFields({
					tx,
					ids: [invoice.id],
					patch: { metadata: { amount: 99_999 } },
					approvedFields: ["vendor"],
				});
				await patchEntityRows({ tx, ids: [invoice.id], patch });
			}),
		).rejects.toThrow(/approved vendor/);
		expect((await readMetadata(invoice.id)).amount).toBe(100);
	}, 60_000);

	it("the apply seam (mergeEntityFields) forwards a covered grant and lands the write", async () => {
		const { user, invoice } = await seedInvoice("draft");

		const sql = getTestDb();
		await sql.begin(async (tx) => {
			const merge = await mergeEntityFields({
				tx,
				entityId: invoice.id,
				fields: { amount: 60_000 },
				source: "human",
				actorId: user.id,
				approvedFields: ["amount"],
			});
			expect(merge.applied["amount"]).toBeTruthy();
		});

		expect((await readMetadata(invoice.id)).amount).toBe(60_000);
	}, 60_000);

	it("the apply seam refuses a grant for a field the rule escalated, with the gap named", async () => {
		const { user, invoice } = await seedInvoice("issued");

		const sql = getTestDb();
		await expect(
			sql.begin(async (tx) => {
				await mergeEntityFields({
					tx,
					entityId: invoice.id,
					fields: { amount: 60_000 },
					source: "human",
					actorId: user.id,
					approvedFields: ["vendor"],
				});
			}),
		).rejects.toThrow(/approved vendor/);
		expect((await readMetadata(invoice.id)).amount).toBe(100);
	}, 60_000);

	it("create applies only what a card showed: no grant stops it, a wrong grant names the gap", async () => {
		const org = await createTestOrganization({ name: "Create grant" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedType(org.id, "invoice", escalateCompiled);

		const base = {
			entity_type: "invoice",
			name: "INV-BIG",
			organization_id: org.id,
			created_by: user.id,
			metadata: { status: "draft", amount: 75_000 },
		} as Parameters<typeof createEntity>[0];

		await expect(createEntity(base)).rejects.toThrow(
			/approval required for amount/,
		);

		await expect(createEntity(base, { approvedFields: ["vendor"] })).rejects.toThrow(
			/approved vendor/,
		);

		const created = await createEntity(base, { approvedFields: ["amount"] });
		expect((await readMetadata(created.id)).amount).toBe(75_000);
	}, 60_000);
});