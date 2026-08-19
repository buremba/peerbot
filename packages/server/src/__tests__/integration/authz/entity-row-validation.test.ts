/**
 * Entity row validation at the physical writer, driven by a type's compiled
 * write rules.
 *
 * These run the REAL path: an author's rule source is compiled exactly as the
 * apply path would store it, written to `entity_types.rules_compiled`, and then
 * exercised through the real CRUD entry points (`createEntity`, `updateEntity`,
 * `deleteEntity`) — not through the validator in isolation. A rule that is never
 * reached would pass a unit test of the evaluator and fail here, which is the
 * failure mode worth catching.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import {
	createEntity,
	deleteEntity,
	updateEntity,
} from "../../../utils/entity-management";
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

/** PROBE: a rule that asks for review of the delete itself. */
const ESCALATE_DELETE_RULE = `
export default (row) => {
  if (row.op === "update" && row.changed("$deleted") && row.next.$deleted) {
    row.escalate(["$deleted"], "a delete needs a second pair of eyes");
  }
};
`;

const TEST_ENV = {} as Env;

// esbuild costs ~100ms per call, so compile each rule once for the whole file.
let invoiceCompiled: string;
let ticketCompiled: string;
let escalateDeleteCompiled: string;

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

async function readDeletedAt(id: number): Promise<Date | null> {
	const sql = getTestDb();
	const rows = await sql<{ deleted_at: Date | null }[]>`
    SELECT deleted_at FROM entities WHERE id = ${id}
  `;
	return rows[0].deleted_at;
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

/** A doc whose type asks for review of any delete. */
async function seedEscalatingDoc() {
	const { org, user } = await seedOrg("Escalating delete");
	await seedType(org.id, "doc", escalateDeleteCompiled);
	const doc = await createEntity({
		entity_type: "doc",
		name: "DOC-1",
		organization_id: org.id,
		created_by: user.id,
		metadata: {},
	} as Parameters<typeof createEntity>[0]);
	return { org, user, doc };
}

describe("entity row validation at the physical writer", () => {
	beforeAll(async () => {
		[invoiceCompiled, ticketCompiled, escalateDeleteCompiled] = await Promise.all([
			compileEntityRule(INVOICE_RULE),
			compileEntityRule(TICKET_RULE),
			compileEntityRule(ESCALATE_DELETE_RULE),
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

	describe("soft delete", () => {
		/**
		 * A rule sees a soft delete as `$deleted: false -> true`, so the SAME
		 * frozen-field clause that stops an edit stops the delete. That is the point
		 * of routing it through the seam: freezing a row has to mean the row cannot
		 * be tombstoned out from under the rule, not merely that its fields resist
		 * editing.
		 */
		it("denies deleting a frozen row, and the row stays live", async () => {
			const { org, user, invoice } = await seedInvoice("posted");

			await expect(
				deleteEntity(invoice.id, false, TEST_ENV, ctxFor(org.id, { userId: user.id })),
			).rejects.toThrow(/posted is frozen: \$deleted is not writable/);

			// The verdict has to have stopped the WRITE, not merely produced an error
			// after it. Read the tombstone column itself rather than trusting the throw.
			expect(await readDeletedAt(invoice.id)).toBeNull();
		}, 60_000);

		it("denies an AGENT the same delete — validation has no principal in it", async () => {
			const { org, agent, invoice } = await seedInvoice("posted");

			await expect(
				deleteEntity(invoice.id, false, TEST_ENV, ctxFor(org.id, { agentId: agent.agentId })),
			).rejects.toThrow(/posted is frozen: \$deleted is not writable/);

			expect(await readDeletedAt(invoice.id)).toBeNull();
		}, 60_000);

		/**
		 * The complement, and the reason the test above is not vacuous: the seam has
		 * to stop the delete the rule objects to WITHOUT stopping delete generally.
		 */
		it("allows deleting a row the rule does not freeze", async () => {
			const { org, user, invoice } = await seedInvoice("draft");

			await deleteEntity(invoice.id, false, TEST_ENV, ctxFor(org.id, { userId: user.id }));

			expect(await readDeletedAt(invoice.id)).not.toBeNull();
		}, 60_000);

		/**
		 * Deleting twice is a no-op, not an error: the lock finds no live row, so
		 * there is nothing for a rule to judge and nothing to write.
		 */
		it("is a no-op on an already-tombstoned row", async () => {
			const { org, user, invoice } = await seedInvoice("draft");
			const ctx = ctxFor(org.id, { userId: user.id });

			await deleteEntity(invoice.id, false, TEST_ENV, ctx);
			const first = await readDeletedAt(invoice.id);

			await deleteEntity(invoice.id, false, TEST_ENV, ctx);
			expect(await readDeletedAt(invoice.id)).toEqual(first);
		}, 60_000);

		/** A type with no rule at all must not pay for the seam existing. */
		it("allows deleting a row whose type declares no rule", async () => {
			const { org, user, invoice } = await seedInvoice("posted", null);

			await deleteEntity(invoice.id, false, TEST_ENV, ctxFor(org.id, { userId: user.id }));

			expect(await readDeletedAt(invoice.id)).not.toBeNull();
		}, 60_000);

		/**
		 * An escalate on the delete stops an ORDINARY delete: there is no grant, so
		 * the write kernel refuses exactly as it does for a field edit nobody
		 * approved.
		 */
		it("stops an unapproved delete when the rule escalates", async () => {
			const { org, user, doc } = await seedEscalatingDoc();

			await expect(
				deleteEntity(doc.id, false, TEST_ENV, ctxFor(org.id, { userId: user.id })),
			).rejects.toThrow(/second pair of eyes \(approval required for \$deleted\)/);

			expect(await readDeletedAt(doc.id)).toBeNull();
		}, 60_000);

		/**
		 * ...and the SAME rule must not block the delete a human then approved.
		 * Without the grant the card is a dead end: applying it re-runs the rule,
		 * escalates again, and throws — the approval could never be honoured.
		 */
		it("honours an approved delete the rule escalated", async () => {
			const { org, user, doc } = await seedEscalatingDoc();

			await deleteEntity(doc.id, false, TEST_ENV, ctxFor(org.id, { userId: user.id }), {
				approvedFields: ["$deleted"],
			});

			expect(await readDeletedAt(doc.id)).not.toBeNull();
		}, 60_000);

		/**
		 * A dry run exists to answer "may I delete this?" before committing. Once
		 * the rule governs the delete, a preview that ignores the rule answers the
		 * wrong question — and answers it optimistically, which is the worst way to
		 * be wrong here.
		 */
		it("reports the rule verdict in a dry run instead of promising the delete", async () => {
			const { org, user, invoice } = await seedInvoice("posted");

			const preview = await deleteEntity(
				invoice.id,
				false,
				TEST_ENV,
				ctxFor(org.id, { userId: user.id }),
				{ dryRun: true },
			);

			expect(preview.message).toMatch(/would NOT be deleted/);
			expect(preview.message).toMatch(/posted is frozen: \$deleted is not writable/);
			expect(preview.deleted).toBe(0);
			// A dry run mutates nothing, verdict or no verdict.
			expect(await readDeletedAt(invoice.id)).toBeNull();
		}, 60_000);

		it("still promises the delete in a dry run the rule permits", async () => {
			const { org, user, invoice } = await seedInvoice("draft");

			const preview = await deleteEntity(
				invoice.id,
				false,
				TEST_ENV,
				ctxFor(org.id, { userId: user.id }),
				{ dryRun: true },
			);

			expect(preview.message).toBe("Dry run: entity would be soft-deleted");
			expect(await readDeletedAt(invoice.id)).toBeNull();
		}, 60_000);

		/** The grant is SCOPED: it covers `$deleted` and nothing else. */
		it("does not let a delete grant waive an escalate on another field", async () => {
			const { org, user, invoice } = await seedInvoice("posted");

			// The invoice rule DENIES this delete. A grant may not launder a deny —
			// only an escalate — so the delete still fails with the grant present.
			await expect(
				deleteEntity(invoice.id, false, TEST_ENV, ctxFor(org.id, { userId: user.id }), {
					approvedFields: ["$deleted"],
				}),
			).rejects.toThrow(/posted is frozen: \$deleted is not writable/);

			expect(await readDeletedAt(invoice.id)).toBeNull();
		}, 60_000);
	});
});
