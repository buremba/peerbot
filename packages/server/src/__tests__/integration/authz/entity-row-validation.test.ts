/**
 * Entity row validation at the physical writer, driven by a type's compiled
 * write rules.
 *
 * These run the REAL path: an author's rule source is compiled exactly as the
 * apply path would store it, written to `entity_types.rules_compiled`, and then
 * exercised through `updateEntity` — not through the validator in isolation. A
 * rule that is never reached would pass a unit test of the evaluator and fail
 * here, which is the failure mode worth catching.
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

/** The invoice lifecycle as an author would write it. */
const INVOICE_RULE = `
const ALLOWED = { draft: ["issued"], issued: ["posted"], posted: [] };
const FROZEN = ["issued", "posted"];
const WRITABLE_ON_EXIT = { "issued->posted": ["einvoice_uuid"] };

export default (row) => {
  if (row.op === "create") {
    if (row.next.status !== "draft") {
      row.deny("an invoice is created in draft, not " + row.next.status);
    }
    return;
  }

  const from = row.committed.status;
  const to = row.next.status;
  if (row.changed("status") && !(ALLOWED[from] || []).includes(to)) {
    row.deny("cannot move " + from + " -> " + to);
  }

  if (!FROZEN.includes(from)) return;
  const permitted = ["status"].concat(WRITABLE_ON_EXIT[from + "->" + to] || []);
  for (const field of Object.keys(row.patch)) {
    if (permitted.includes(field)) continue;
    if (!row.changed(field)) continue;
    row.deny(from + " is frozen: " + field + " is not writable");
  }
};
`;

/** A lifecycle with nothing ERP about it, to prove the seam is type-scoped. */
const TICKET_RULE = `
export default (row) => {
  if (row.op === "update" && row.committed.state === "closed" && row.next.state === "open") {
    row.deny("a closed ticket cannot be reopened");
  }
};
`;

const TEST_ENV = {} as Env;

// esbuild costs ~100ms per call, so compile each rule once for the whole file.
let invoiceCompiled: string;
let ticketCompiled: string;

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

async function seedOrg(name: string) {
	const org = await createTestOrganization({ name });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	return { org, user, agent };
}

/**
 * Seed an invoice and walk it to `status` through legal transitions only.
 * Creates are validated now, so a fixture cannot be born mid-lifecycle — it has
 * to get there the way a tenant would.
 */
async function seedInvoice(
	status: "draft" | "issued" | "posted",
	rule: string | null = invoiceCompiled,
) {
	const { org, user, agent } = await seedOrg(`Invoice ${status}`);
	await seedType(org.id, "invoice", rule);

	const invoice = await createEntity({
		entity_type: "invoice",
		name: "INV-1",
		organization_id: org.id,
		created_by: user.id,
		metadata: { status: "draft", einvoice_uuid: null, amount: 100 },
	} as Parameters<typeof createEntity>[0]);

	const ctx = ctxFor(org.id, { userId: user.id });
	if (status === "issued" || status === "posted") {
		await updateEntity(
			invoice.id,
			{ metadata: { status: "issued" } },
			TEST_ENV,
			ctx,
		);
	}
	if (status === "posted") {
		await updateEntity(
			invoice.id,
			{ metadata: { status: "posted", einvoice_uuid: "uuid-seed" } },
			TEST_ENV,
			ctx,
		);
	}
	return { org, user, agent, invoice };
}

describe("entity row validation at the physical writer", () => {
	beforeAll(async () => {
		[invoiceCompiled, ticketCompiled] = await Promise.all([
			compileEntityRule(INVOICE_RULE),
			compileEntityRule(TICKET_RULE),
		]);
	}, 60_000);

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("denies an AGENT editing a frozen document", async () => {
		const { org, agent, invoice } = await seedInvoice("posted");

		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { amount: 999 } },
				TEST_ENV,
				ctxFor(org.id, { agentId: agent.agentId }),
			),
		).rejects.toThrow(/posted is frozen: amount/);

		expect((await readMetadata(invoice.id)).amount).toBe(100);
	}, 60_000);

	it("denies a HUMAN editing a frozen document — validation has no principal in it", async () => {
		const { org, user, invoice } = await seedInvoice("posted");

		// The permission gate carves out humans. This seam answers a different
		// question ("is the resulting state legal"), so an owner is denied too.
		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { amount: 999 } },
				TEST_ENV,
				ctxFor(org.id, { userId: user.id }),
			),
		).rejects.toThrow(/posted is frozen: amount/);
	}, 60_000);

	it("denies an illegal transition and permits a legal one", async () => {
		const { org, user, invoice } = await seedInvoice("draft");
		const ctx = ctxFor(org.id, { userId: user.id });

		await expect(
			updateEntity(invoice.id, { metadata: { status: "posted" } }, TEST_ENV, ctx),
		).rejects.toThrow(/cannot move draft -> posted/);
		expect((await readMetadata(invoice.id)).status).toBe("draft");

		await updateEntity(
			invoice.id,
			{ metadata: { status: "issued" } },
			TEST_ENV,
			ctx,
		);
		expect((await readMetadata(invoice.id)).status).toBe("issued");
	}, 60_000);

	it("permits a writableOnExit field in the same write as its move", async () => {
		const { org, user, invoice } = await seedInvoice("issued");

		await updateEntity(
			invoice.id,
			{ metadata: { status: "posted", einvoice_uuid: "uuid-xyz" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("posted");
		expect(after.einvoice_uuid).toBe("uuid-xyz");
	}, 60_000);

	it("denies renaming a frozen document", async () => {
		const { org, user, invoice } = await seedInvoice("posted");

		// Freezing a document has to stop a rename, not merely a metadata edit —
		// which is why `$name` is a governed column rather than an ungoverned one.
		await expect(
			updateEntity(invoice.id, { name: "INV-RENAMED" }, TEST_ENV, ctxFor(org.id, {
				userId: user.id,
			})),
		).rejects.toThrow(/posted is frozen: \$name/);
	}, 60_000);

	it("permits an idempotent rewrite of an unchanged value while frozen", async () => {
		const { org, user, invoice } = await seedInvoice("posted");

		await updateEntity(
			invoice.id,
			{ metadata: { amount: 100 } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		expect((await readMetadata(invoice.id)).amount).toBe(100);
	}, 60_000);

	it("leaves a type declaring no rules untouched", async () => {
		const { org, user, invoice } = await seedInvoice("draft", null);

		// No rule means no isolate — the write that the invoice rule would have
		// rejected outright goes straight through.
		await updateEntity(
			invoice.id,
			{ metadata: { status: "posted" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		expect((await readMetadata(invoice.id)).status).toBe("posted");
	}, 60_000);

	it("ignores a write that leaves the governed field untouched", async () => {
		const { org, user, invoice } = await seedInvoice("posted");

		// Regression for a real defect: `changed()` reported key presence, so this
		// write — which does not touch `status` at all — was denied by the
		// transition guard. A unit test missed it because its fixtures were
		// delta-shaped; only the seam produces the merged shape that exposes it.
		await updateEntity(
			invoice.id,
			{ metadata: { einvoice_uuid: "uuid-seed" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		expect((await readMetadata(invoice.id)).status).toBe("posted");
	}, 60_000);

	it("scopes rules to their own type", async () => {
		const { org, user } = await seedOrg("Mixed types");
		await seedType(org.id, "invoice", invoiceCompiled);
		await seedType(org.id, "ticket", ticketCompiled);
		const ctx = ctxFor(org.id, { userId: user.id });

		const ticket = await createEntity({
			entity_type: "ticket",
			name: "TCK-1",
			organization_id: org.id,
			created_by: user.id,
			metadata: { state: "open" },
		} as Parameters<typeof createEntity>[0]);

		// The invoice rule would have denied a create whose status is not "draft".
		// The ticket has no `status` at all and its own rule permits the create.
		await updateEntity(ticket.id, { metadata: { state: "closed" } }, TEST_ENV, ctx);
		expect((await readMetadata(ticket.id)).state).toBe("closed");

		await expect(
			updateEntity(ticket.id, { metadata: { state: "open" } }, TEST_ENV, ctx),
		).rejects.toThrow(/closed ticket cannot be reopened/);
	}, 60_000);
});
