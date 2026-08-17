/**
 * SPIKE (case 3): does an approval hold on the state field turn a LEGAL
 * transition into a frozen-state violation, losing both the write and the
 * approval card?
 *
 * Sequence under test:
 *   1. invoice sits in `draft`
 *   2. a HUMAN moves it to `issued` — legal, and claims ownership of `status`
 *   3. an AGENT proposes the legal exit `issued -> posted` together with
 *      `einvoice_uuid`, the one field `writableOnExit` permits on that move
 *   4. the permission gate holds `status` (human-owned), so `computeFieldMerge`
 *      strips it from the patch
 *   5. the effective patch is `{ einvoice_uuid }` with NO transition — and in a
 *      frozen state that is illegal, so validation denies the whole write
 *
 * The agent proposed something legal. An unrelated ownership hold made it
 * illegal. And `entity-management.ts` builds the approval deferral at `:1147`,
 * AFTER the transaction returns at `:1134` — so the throw means no card is
 * queued either. The work is denied and dropped.
 *
 * The control test proves the hold is the cause: the identical agent write
 * succeeds when no human owns `status`.
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

async function runCount(organizationId: string): Promise<number> {
	const sql = getTestDb();
	const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM runs WHERE organization_id = ${organizationId}
  `;
	return Number(rows[0].n);
}

async function seed() {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Approval Hold Spike" });
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
	const invoice = await createEntity({
		entity_type: "invoice",
		name: "INV-SPIKE",
		organization_id: org.id,
		created_by: user.id,
		metadata: { status: "draft", einvoice_uuid: null },
	} as Parameters<typeof createEntity>[0]);
	return { org, user, agent, invoice };
}

describe("SPIKE: approval hold vs a frozen-state invariant", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("CONTROL: the agent's legal exit succeeds when no human owns `status`", async () => {
		const { org, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });

		// An AGENT moves draft -> issued, so no human ownership is claimed.
		await updateEntity(
			invoice.id,
			{ metadata: { status: "issued" } },
			TEST_ENV,
			agentCtx,
		);
		expect((await readMetadata(invoice.id)).status).toBe("issued");

		// The legal exit, carrying the field writableOnExit permits.
		await updateEntity(
			invoice.id,
			{ metadata: { status: "posted", einvoice_uuid: "uuid-xyz" } },
			TEST_ENV,
			agentCtx,
		);

		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("posted");
		expect(after.einvoice_uuid).toBe("uuid-xyz");
	});

	it("BUG: the identical write is denied once a human owns `status`", async () => {
		const { org, user, agent, invoice } = await seed();

		// A HUMAN moves draft -> issued. Legal, and it claims ownership of `status`.
		await updateEntity(
			invoice.id,
			{ metadata: { status: "issued" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);
		expect((await readMetadata(invoice.id)).status).toBe("issued");

		const runsBefore = await runCount(org.id);

		// The SAME legal exit the control test just performed successfully.
		const attempt = updateEntity(
			invoice.id,
			{ metadata: { status: "posted", einvoice_uuid: "uuid-xyz" } },
			TEST_ENV,
			ctxFor(org.id, { agentId: agent.agentId }),
		);

		await expect(attempt).rejects.toThrow(/frozen/i);

		// Nothing landed: not the transition, not the permitted companion field.
		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("issued");
		expect(after.einvoice_uuid ?? null).toBeNull();

		// And no approval card was queued, because the deferral is built after the
		// transaction returns and the throw skipped it.
		expect(await runCount(org.id)).toBe(runsBefore);
	});
});
