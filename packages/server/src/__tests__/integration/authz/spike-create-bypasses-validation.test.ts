/**
 * SPIKE — does the CREATE path reach the validation seam?
 *
 * Code reading says no: `insertEntityRow` (`entity-management.ts:453`, used at
 * `:828`) never calls `validateEntityRowPatch`. Only `:643` and `:1121` do, and
 * both are update paths.
 *
 * If that reading is right, every state rule is trivially routable: an agent
 * that writes the document in its final state on the FIRST insert is never
 * evaluated. "Posting requires an e-invoice UUID" would only bite someone who
 * took a legal draft and edited it — i.e. someone already following the rules.
 *
 * This test asserts the CURRENT behaviour so the gap is a fact rather than an
 * inference. When creates are brought under validation, the first two cases
 * flip and this file becomes the regression test for that change.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createEntity, updateEntity } from "../../../utils/entity-management";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

/**
 * `posted` is terminal and frozen. Reaching it legally requires passing through
 * `issued`, and `einvoice_uuid` is only writable on the exit INTO `posted`.
 */
const TRANSITIONS = {
	field: "status",
	states: {
		draft: { to: ["issued"] },
		issued: {
			to: ["posted"],
			frozen: true,
			writableOnExit: { posted: ["einvoice_uuid"] },
		},
		posted: { to: [], frozen: true },
	},
};

const TEST_ENV = {} as Env;

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
	const org = await createTestOrganization({ name: "Create Bypass Spike" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema,
                              created_at, updated_at)
    VALUES (${org.id}, 'invoice', 'invoice',
            ${sql.json({ type: "object", "x-transitions": TRANSITIONS })},
            current_timestamp, current_timestamp)
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

describe("SPIKE: does CREATE reach the validation seam?", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("creates an invoice DIRECTLY in the terminal frozen state, skipping every transition", async () => {
		const { org, user } = await seedOrg();

		const invoice = await createEntity({
			entity_type: "invoice",
			name: "INV-BORN-POSTED",
			organization_id: org.id,
			created_by: user.id,
			// `draft -> posted` is not a legal exit, and `posted` is terminal.
			// An update attempting this is denied (asserted below).
			metadata: { status: "posted", einvoice_uuid: "uuid-1" },
		} as Parameters<typeof createEntity>[0]);

		expect(await statusOf(invoice.id)).toBe("posted");
	}, 30_000);

	it("creates a POSTED invoice with NO e-invoice UUID — the invariant never runs", async () => {
		const { org, user } = await seedOrg();

		const invoice = await createEntity({
			entity_type: "invoice",
			name: "INV-POSTED-NO-UUID",
			organization_id: org.id,
			created_by: user.id,
			metadata: { status: "posted" },
		} as Parameters<typeof createEntity>[0]);

		const sql = getTestDb();
		const rows = await sql<{ metadata: unknown }[]>`
      SELECT metadata FROM entities WHERE id = ${invoice.id}`;
		const raw = rows[0].metadata;
		const md = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
			string,
			unknown
		>;

		expect(md.status).toBe("posted");
		expect(md.einvoice_uuid).toBeUndefined();
	}, 30_000);

	it("CONTRAST: the same end state is DENIED when reached by update", async () => {
		const { org, user, agent } = await seedOrg();

		const invoice = await createEntity({
			entity_type: "invoice",
			name: "INV-LEGAL-DRAFT",
			organization_id: org.id,
			created_by: user.id,
			metadata: { status: "draft", einvoice_uuid: null },
		} as Parameters<typeof createEntity>[0]);

		await expect(
			updateEntity(
				{
					entity_id: String(invoice.id),
					metadata: { status: "posted", einvoice_uuid: "uuid-1" },
				} as Parameters<typeof updateEntity>[0],
				ctxFor(org.id, { userId: user.id, agentId: agent.agentId }),
				TEST_ENV,
			),
		).rejects.toThrow();

		// And the row is untouched — the deny rolled the write back.
		expect(await statusOf(invoice.id)).toBe("draft");
	}, 30_000);
});
