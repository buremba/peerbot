/**
 * An escalated card is ONE unit at propose time, so it must be one unit at
 * apply time too.
 *
 * `updateEntity` defers the WHOLE proposal when a rule escalates — the card
 * comment says so explicitly: "the card carries the entire proposal, so
 * approving it re-runs the whole thing as one legal transition instead of the
 * fragment that could not stand on its own."
 *
 * But the apply path stale-skips per field. So if any single field of an
 * escalated card diverges between propose and approve, that field is dropped
 * and the REST of the card commits — the exact fragment the propose-time
 * comment promised would never exist. The human consented to a coupled
 * transition and got half of it.
 *
 * Sequence under test:
 *   1. an agent proposes `{ amount: 90000, vendor: "ACME" }`
 *   2. the rule escalates `amount`, so the WHOLE write defers as one card
 *   3. a human edits `amount` to a legal value before deciding the card
 *   4. the approver approves the card
 *
 * Correct: nothing commits. The reviewed unit no longer describes the row, so
 * the whole apply rolls back and the run resolves as skipped (stale) — the
 * newer human value stands and no fragment is written.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import {
	createEntity,
	updateEntity,
} from "../../../utils/entity-management";
import {
	applyEntityChangeProposal,
	applyEntityFieldChangeProposal,
	proposeEntityDelete,
} from "../../../tools/admin/entity-field-approval";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { initWorkspaceProvider } from "../../../workspace";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

/**
 * Escalates on size alone. No frozen-state loop and no deny, so the residual
 * cannot trip a denial before the escalation under test is reached, and the
 * human's intervening correction to a legal amount applies outright.
 */
const ESCALATE_ON_SIZE_RULE = `
export default (row) => {
  if (row.op === "create") return;
  if (row.next.amount > 50000) {
    row.escalate(["amount"], "an invoice over 50k needs sign-off");
  }
};
`;

/** Escalates on the DELETE itself, so applying the card re-asks the same question. */
const ESCALATE_ON_DELETE_RULE = `
export default (row) => {
  if (row.op === "update" && row.changed("$deleted") && row.next.$deleted) {
    row.escalate(["$deleted"], "deleting an invoice needs sign-off");
  }
};
`;

const TEST_ENV = {} as Env;
let escalateOnSizeCompiled: string;
let escalateOnDeleteCompiled: string;

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

async function readName(id: number): Promise<string | null> {
	const sql = getTestDb();
	const rows = await sql<{ name: string | null }[]>`
    SELECT name FROM entities WHERE id = ${id}
  `;
	return rows[0].name;
}

async function seed() {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Atomic Apply" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema,
                              rules_compiled, created_at, updated_at)
    VALUES (${org.id}, 'invoice', 'invoice', ${sql.json({ type: "object" })},
            ${escalateOnSizeCompiled}, current_timestamp, current_timestamp)
  `;
	const invoice = await createEntity({
		entity_type: "invoice",
		name: "INV-ATOMIC",
		organization_id: org.id,
		created_by: user.id,
		metadata: { status: "draft", amount: 1000, vendor: null },
	} as Parameters<typeof createEntity>[0]);
	return { org, user, agent, invoice };
}

/** The proposal exactly as the card persisted it — never a hand-built one. */
async function persistedProposal(organizationId: string): Promise<{
	entity_id: number;
	fields: Record<string, unknown>;
	current: Record<string, unknown>;
	escalated_fields?: string[];
}> {
	const sql = getTestDb();
	const [queued] = await sql<{ action_input: unknown }[]>`
    SELECT action_input FROM runs
    WHERE organization_id = ${organizationId}
    ORDER BY id DESC LIMIT 1
  `;
	return (
		typeof queued.action_input === "string"
			? JSON.parse(queued.action_input)
			: queued.action_input
	) as {
		entity_id: number;
		fields: Record<string, unknown>;
		current: Record<string, unknown>;
		escalated_fields?: string[];
	};
}

describe("an escalated card applies atomically or not at all", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		[escalateOnSizeCompiled, escalateOnDeleteCompiled] = await Promise.all([
			compileEntityRule(ESCALATE_ON_SIZE_RULE),
			compileEntityRule(ESCALATE_ON_DELETE_RULE),
		]);
	}, 60_000);

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("does not commit the rest of the card when one escalated field went stale", async () => {
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });

		// 1-2. The rule escalates `amount`, so the WHOLE proposal defers.
		const result = await updateEntity(
			invoice.id,
			{ metadata: { amount: 90000, vendor: "ACME" } },
			TEST_ENV,
			agentCtx,
		);
		expect(result.deferred).toBeTruthy();
		// Nothing commits at propose time — that is the invariant being carried.
		const atPropose = await readMetadata(invoice.id);
		expect(atPropose.amount).toBe(1000);
		expect(atPropose.vendor ?? null).toBeNull();

		await result.deferred?.queue(agentCtx, TEST_ENV);
		const proposal = await persistedProposal(org.id);
		// The card really is the coupled unit, not just the escalated field.
		expect(proposal.fields).toEqual({ amount: 90000, vendor: "ACME" });
		expect(proposal.escalated_fields).toEqual(["amount"]);

		// 3. A human corrects `amount` to a legal value before deciding the card.
		// Under 50k, so the rule does not escalate and this commits outright.
		await updateEntity(
			invoice.id,
			{ metadata: { amount: 40000 } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);
		expect((await readMetadata(invoice.id)).amount).toBe(40000);

		// 4. Approve the card as persisted.
		await applyEntityFieldChangeProposal(
			proposal as Parameters<typeof applyEntityFieldChangeProposal>[0],
			user.id,
		);

		const after = await readMetadata(invoice.id);
		// The human's newer value must win — this part already works.
		expect(after.amount).toBe(40000);
		// THE REGRESSION: `vendor` is the other half of a unit the approver
		// consented to as a whole. With `amount` no longer applicable, the unit is
		// not applicable, and the fragment must not commit on its own.
		expect(after.vendor ?? null).toBeNull();
	}, 60_000);

	it("rolls the metadata half back when the card's $name went stale", async () => {
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });

		// A card mixing an ATTRIBUTE key with metadata runs through two writers:
		// `mergeEntityFields` first, then `patchEntityRows`. Staleness discovered by
		// the second must still unwind the first.
		const result = await updateEntity(
			invoice.id,
			{ name: "INV-RENAMED", metadata: { amount: 90000 } },
			TEST_ENV,
			agentCtx,
		);
		expect(result.deferred).toBeTruthy();
		await result.deferred?.queue(agentCtx, TEST_ENV);
		const proposal = await persistedProposal(org.id);
		expect(proposal.fields).toMatchObject({
			$name: "INV-RENAMED",
			amount: 90000,
		});

		// The human renames the row, so the ATTRIBUTE half is what diverges.
		await updateEntity(
			invoice.id,
			{ name: "INV-HUMAN" },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		await applyEntityFieldChangeProposal(
			proposal as Parameters<typeof applyEntityFieldChangeProposal>[0],
			user.id,
		);

		expect(await readName(invoice.id)).toBe("INV-HUMAN");
		// Asserting only the name would pass with the metadata half committed.
		expect((await readMetadata(invoice.id)).amount).toBe(1000);
	}, 60_000);

	it("CONTROL: a hold card with no escalation still applies its live fields", async () => {
		const { org, user, agent, invoice } = await seed();
		const humanCtx = ctxFor(org.id, { userId: user.id });

		// A human owns both fields, so the agent's write is held field by field —
		// no rule escalates (`amount` stays under the threshold). This card carries
		// per-field consent, and atomicity must NOT be imposed on it: the human owns
		// each VALUE, not the row.
		await updateEntity(
			invoice.id,
			{ metadata: { vendor: "OLD", notes: "n0" } },
			TEST_ENV,
			humanCtx,
		);

		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });
		const result = await updateEntity(
			invoice.id,
			{ metadata: { vendor: "ACME", notes: "n1" } },
			TEST_ENV,
			agentCtx,
		);
		expect(result.deferred).toBeTruthy();
		await result.deferred?.queue(agentCtx, TEST_ENV);
		const proposal = await persistedProposal(org.id);
		expect(proposal.escalated_fields ?? []).toEqual([]);
		expect(proposal.fields).toEqual({ vendor: "ACME", notes: "n1" });

		// The human re-edits ONE of the two before deciding the card.
		await updateEntity(
			invoice.id,
			{ metadata: { vendor: "HUMAN" } },
			TEST_ENV,
			humanCtx,
		);

		await applyEntityFieldChangeProposal(
			proposal as Parameters<typeof applyEntityFieldChangeProposal>[0],
			user.id,
		);

		const after = await readMetadata(invoice.id);
		// Stale field skipped, the other one still applies. Widening the atomicity
		// check past escalated cards would strand this card instead.
		expect(after.vendor).toBe("HUMAN");
		expect(after.notes).toBe("n1");
	}, 60_000);
});

/**
 * A DELETE card is the same promise as an update card: what the human approved
 * must be what applying it performs.
 *
 * Soft delete is now governed by write rules, so a rule may escalate on
 * `$deleted`. Applying the card re-runs that rule against the same row, so
 * without a grant it escalates a second time and throws — the card is minted, a
 * human approves it, and the delete still never happens. That dead end is what
 * this covers, end to end through the PERSISTED card rather than a hand-built
 * proposal.
 */
describe("an approved DELETE card is honoured despite the rule that escalated it", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("applies the persisted delete card and tombstones the row", async () => {
		const sql = getTestDb();
		const { org, user, invoice } = await seed();

		// The rule escalates on any delete of this type.
		await sql`
      UPDATE entity_types SET rules_compiled = ${escalateOnDeleteCompiled}
      WHERE organization_id = ${org.id} AND slug = 'invoice'
    `;

		const ctx = ctxFor(org.id, { userId: user.id });
		await proposeEntityDelete(ctx, {
			entity_id: invoice.id,
			entity_type: "invoice",
			name: invoice.name,
			force_delete_tree: false,
		} as Parameters<typeof proposeEntityDelete>[1]);

		// Read back what the card actually stored — a hand-built proposal would
		// pass with the propose->persist->apply plumbing severed.
		const [queued] = await sql<{ action_input: unknown }[]>`
      SELECT action_input FROM runs
      WHERE organization_id = ${org.id}
      ORDER BY id DESC LIMIT 1
    `;
		const proposal = (
			typeof queued.action_input === "string"
				? JSON.parse(queued.action_input)
				: queued.action_input
		) as Record<string, unknown>;
		expect(proposal.entity_id).toBe(invoice.id);
		expect(proposal.operation).toBe("delete");

		// Apply INSIDE a transaction, because that is what production does:
		// approvals.ts wraps the whole claim+confirm+apply in `sql.begin` and
		// hands `completeApproval` the tx. Passing the pool here would skip the
		// one shape worth proving — `deleteEntity` opens its OWN transaction on a
		// SECOND pooled connection while this one is still open, and takes
		// `FOR UPDATE` on a row the outer tx has not locked.
		await sql.begin(async (tx) => {
			await applyEntityChangeProposal(proposal as never, ctx, TEST_ENV, tx);
		});

		const [row] = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM entities WHERE id = ${invoice.id}
    `;
		expect(row.deleted_at).not.toBeNull();
	}, 60_000);
});
