/**
 * The validation seam at `patchEntityRows`, exercised against real Postgres.
 *
 * The property under test is not "transitions work" but WHERE they are enforced.
 * Validation sits on the physical row writer, so it applies to every caller
 * regardless of principal and regardless of which door the write came through —
 * which is why the human-edit case below passes without touching the
 * `isHumanEdit` carve-out in `updateEntity`.
 */

import { beforeEach, describe, expect, it } from "vitest";
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

const INVOICE_TRANSITIONS = {
	field: "status",
	states: {
		draft: { to: ["issued", "cancelled"] },
		issued: {
			to: ["posted", "cancelled"],
			frozen: true,
			writableOnExit: { posted: ["einvoice_uuid"] },
		},
		posted: { to: [], frozen: true },
		cancelled: { to: [], frozen: true },
	},
};

const TEST_ENV = {} as Env;

async function seedType(
	orgId: string,
	slug: string,
	transitions: unknown,
): Promise<void> {
	const sql = getTestDb();
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema,
                              created_at, updated_at)
    VALUES (${orgId}, ${slug}, ${slug},
            ${sql.json({ type: "object", "x-transitions": transitions })},
            current_timestamp, current_timestamp)
  `;
}

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

async function seedInvoice(status: string, transitions: unknown = INVOICE_TRANSITIONS) {
	const org = await createTestOrganization({ name: "Row Validation" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	await seedType(org.id, "invoice", transitions);
	const invoice = await createEntity({
		entity_type: "invoice",
		name: `INV-${status}`,
		organization_id: org.id,
		created_by: user.id,
		metadata: { status, grand_total: 100 },
	} as Parameters<typeof createEntity>[0]);
	return { org, user, agent, invoice };
}

describe("entity row validation at the physical writer", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("denies an AGENT editing a frozen document", async () => {
		const { org, agent, invoice } = await seedInvoice("posted");

		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { grand_total: 999 } },
				TEST_ENV,
				ctxFor(org.id, { agentId: agent.agentId }),
			),
		).rejects.toThrow(/frozen/i);

		expect((await readMetadata(invoice.id)).grand_total).toBe(100);
	});

	/**
	 * The point of moving validation to the row writer. `updateEntity` still wraps
	 * the PERMISSION gate in `if (!isHumanEdit)`, so a human write reaches no
	 * interceptor — yet it is still refused here, because validation is not keyed
	 * on a principal. If this ever starts passing, validation has drifted back up
	 * into the principal-aware pass.
	 */
	it("denies a HUMAN editing a frozen document, with the gate carve-out untouched", async () => {
		const { org, user, invoice } = await seedInvoice("posted");

		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { grand_total: 999 } },
				TEST_ENV,
				ctxFor(org.id, { userId: user.id }),
			),
		).rejects.toThrow(/frozen/i);

		expect((await readMetadata(invoice.id)).grand_total).toBe(100);
	});

	it("denies an illegal transition and permits a legal one", async () => {
		const { org, user, invoice } = await seedInvoice("draft");
		const ctx = ctxFor(org.id, { userId: user.id });

		await expect(
			updateEntity(invoice.id, { metadata: { status: "posted" } }, TEST_ENV, ctx),
		).rejects.toThrow(/illegal transition/i);
		expect((await readMetadata(invoice.id)).status).toBe("draft");

		await updateEntity(
			invoice.id,
			{ metadata: { status: "issued" } },
			TEST_ENV,
			ctx,
		);
		expect((await readMetadata(invoice.id)).status).toBe("issued");
	});

	it("permits a writableOnExit field in the same write as its move", async () => {
		const { org, user, invoice } = await seedInvoice("issued");

		await updateEntity(
			invoice.id,
			{ metadata: { status: "posted", einvoice_uuid: "GIB-1" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("posted");
		expect(after.einvoice_uuid).toBe("GIB-1");
	});

	it("denies renaming a frozen document", async () => {
		const { org, user, invoice } = await seedInvoice("posted");

		await expect(
			updateEntity(invoice.id, { name: "Renamed" }, TEST_ENV, ctxFor(org.id, {
				userId: user.id,
			})),
		).rejects.toThrow(/frozen/i);
	});

	it("permits an idempotent rewrite of an unchanged value while frozen", async () => {
		const { org, user, invoice } = await seedInvoice("posted");

		await updateEntity(
			invoice.id,
			{ metadata: { grand_total: 100 } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		expect((await readMetadata(invoice.id)).grand_total).toBe(100);
	});

	it("fails closed when a type declares a malformed spec", async () => {
		const { org, user, invoice } = await seedInvoice("posted", {
			field: "status",
			states: "not-an-object",
		});

		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { grand_total: 999 } },
				TEST_ENV,
				ctxFor(org.id, { userId: user.id }),
			),
		).rejects.toThrow(/invalid x-transitions/i);
	});

	it("leaves a type declaring no transitions untouched", async () => {
		const org = await createTestOrganization({ name: "No Spec" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const sql = getTestDb();
		await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'note', 'note', current_timestamp, current_timestamp)
    `;
		const note = await createEntity({
			entity_type: "note",
			name: "Free-form",
			organization_id: org.id,
			created_by: user.id,
			metadata: { status: "posted", body: "x" },
		} as Parameters<typeof createEntity>[0]);

		await updateEntity(
			note.id,
			{ metadata: { body: "y" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);
		expect((await readMetadata(note.id)).body).toBe("y");
	});

	/**
	 * Domain-neutrality check. The engine must know nothing about invoices; the
	 * cheapest way to keep that true is to run the identical path over a support
	 * ticket. If this ever needs its own branch in the rules module, domain
	 * vocabulary has leaked in.
	 */
	it("runs unchanged on a non-ERP lifecycle", async () => {
		const org = await createTestOrganization({ name: "Tickets" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await seedType(org.id, "ticket", {
			field: "state",
			states: {
				open: { to: ["triaged"] },
				triaged: { to: ["closed"] },
				closed: { to: [], frozen: true },
			},
		});
		const ticket = await createEntity({
			entity_type: "ticket",
			name: "TKT-1",
			organization_id: org.id,
			created_by: user.id,
			metadata: { state: "closed", title: "boom" },
		} as Parameters<typeof createEntity>[0]);

		await expect(
			updateEntity(
				ticket.id,
				{ metadata: { title: "edited" } },
				TEST_ENV,
				ctxFor(org.id, { userId: user.id }),
			),
		).rejects.toThrow(/frozen/i);
	});
});
