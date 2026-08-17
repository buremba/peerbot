/**
 * An approval hold may not manufacture an illegal state.
 *
 * Sequence under test:
 *   1. invoice sits in `draft`
 *   2. a HUMAN moves it to `issued` — legal, and claims ownership of `status`
 *   3. an AGENT proposes the legal exit `issued -> posted` together with
 *      `einvoice_uuid`, the one field that move unlocks
 *   4. the permission gate holds `status` (human-owned), so `computeFieldMerge`
 *      strips it from the patch
 *   5. the effective patch is `{ einvoice_uuid }` with NO transition — a naked
 *      field edit in a frozen state, which the rule rejects
 *
 * This used to throw. The agent had proposed something legal; an unrelated
 * ownership hold made it illegal, and because the deferral is built AFTER the
 * transaction returns, the throw skipped it — so the work was denied under a
 * misattributed reason AND the approval card was lost.
 *
 * The fix is not to weaken validation but to stop splitting the write: when the
 * residual fails and fields were held, nothing commits and the ENTIRE proposal
 * defers as one approval unit. The control test proves the hold is what changes
 * the outcome — the identical agent write commits outright when no human owns
 * `status`.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import { createEntity, updateEntity } from "../../../utils/entity-management";
import { applyEntityFieldChangeProposal } from "../../../tools/admin/entity-field-approval";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { initWorkspaceProvider } from "../../../workspace";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

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
  if (row.next.amount > 50000) {
    row.escalate(["amount"], "an invoice over 50k needs sign-off");
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

/**
 * Separates the two verdicts cleanly: no frozen-field logic, so a residual that
 * only touches `amount` ESCALATES instead of tripping a deny first. That split
 * is the point — with the frozen loop above, the residual denies before it can
 * ever escalate, which hides the branch under test.
 */
const ESCALATE_RESIDUAL_RULE = `
export default (row) => {
  if (row.op === "create") return;
  if (row.changed("status") && row.committed.status === "issued" && row.next.status === "draft") {
    row.deny("cannot move issued -> draft");
  }
  if (row.next.amount > 50000) {
    row.escalate(["amount"], "an invoice over 50k needs sign-off");
  }
};
`;

/**
 * Stands in for the rule being redeployed between propose and approve: it
 * escalates a field the approver never saw on their card.
 */
const ESCALATE_VENDOR_RULE = `
export default (row) => {
  if (row.op === "update") row.escalate(["vendor"], "vendor needs sign-off");
};
`;

const TEST_ENV = {} as Env;
let invoiceCompiled: string;
let escalateResidualCompiled: string;
let escalateVendorCompiled: string;

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

async function seed(rules?: string) {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Approval Hold" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	const agent = await createTestAgent({ organizationId: org.id });
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, metadata_schema,
                              rules_compiled, created_at, updated_at)
    VALUES (${org.id}, 'invoice', 'invoice', ${sql.json({ type: "object" })},
            ${rules ?? invoiceCompiled}, current_timestamp, current_timestamp)
  `;
	const invoice = await createEntity({
		entity_type: "invoice",
		name: "INV-HOLD",
		organization_id: org.id,
		created_by: user.id,
		metadata: { status: "draft", einvoice_uuid: null },
	} as Parameters<typeof createEntity>[0]);
	return { org, user, agent, invoice };
}

describe("approval hold vs a frozen-state rule", () => {
	beforeAll(async () => {
		// `queue()` builds an approval URL, which needs the workspace provider.
		await initWorkspaceProvider();
		[invoiceCompiled, escalateResidualCompiled, escalateVendorCompiled] =
			await Promise.all([
				compileEntityRule(INVOICE_RULE),
				compileEntityRule(ESCALATE_RESIDUAL_RULE),
				compileEntityRule(ESCALATE_VENDOR_RULE),
			]);
	}, 60_000);

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

		// The legal exit, carrying the field that move unlocks.
		await updateEntity(
			invoice.id,
			{ metadata: { status: "posted", einvoice_uuid: "uuid-xyz" } },
			TEST_ENV,
			agentCtx,
		);

		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("posted");
		expect(after.einvoice_uuid).toBe("uuid-xyz");
	}, 60_000);

	it("defers the WHOLE write once a human owns `status`, instead of denying it", async () => {
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
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });

		// The SAME legal exit the control test just performed successfully.
		const result = await updateEntity(
			invoice.id,
			{ metadata: { status: "posted", einvoice_uuid: "uuid-xyz" } },
			TEST_ENV,
			agentCtx,
		);

		// Nothing landed — the fragment that could not stand on its own was not
		// committed, and neither was the half of it the gate would have allowed.
		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("issued");
		expect(after.einvoice_uuid ?? null).toBeNull();

		// The card carries the WHOLE proposal, not the held subset: approving it
		// replays a legal transition rather than the naked field edit.
		expect(result.deferred).toBeDefined();
		expect(result.deferred?.display.fields).toEqual({
			status: "posted",
			einvoice_uuid: "uuid-xyz",
		});
		expect(result.deferred?.display.current).toMatchObject({
			status: "issued",
			einvoice_uuid: null,
		});

		// The approval is real, not merely described: queueing it opens a run.
		await result.deferred?.queue(agentCtx, TEST_ENV);
		expect(await runCount(org.id)).toBe(runsBefore + 1);
	}, 60_000);

	it("defers the whole write when a RULE escalates, carrying the rule's own reason", async () => {
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });
		const runsBefore = await runCount(org.id);

		// The invoice stays in `draft`, which is not frozen. A deny legitimately
		// outranks an escalate, so exercising escalation on a frozen row would only
		// ever observe the frozen-field denial.
		//
		// No human owns anything here either, so nothing is held by the permission
		// gate — the escalation is the rule's own decision.
		const result = await updateEntity(
			invoice.id,
			{ metadata: { amount: 90000 } },
			TEST_ENV,
			agentCtx,
		);

		// An escalation holds everything: partial application is what produced the
		// bug above, so a rule asking for review never gets a half-applied write.
		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("draft");
		expect(after.amount ?? null).toBeNull();

		expect(result.deferred?.display.fields).toEqual({ amount: 90000 });

		await result.deferred?.queue(agentCtx, TEST_ENV);
		expect(await runCount(org.id)).toBe(runsBefore + 1);

		// The card must RECORD what the rule escalated. Every apply-path test here
		// hand-builds its proposal, so without this assertion a broken
		// updateEntity -> deferral thread would go unnoticed: the tests would be
		// approving fields they supplied themselves.
		const sql = getTestDb();
		const [queued] = await sql<{ action_input: unknown }[]>`
      SELECT action_input FROM runs
      WHERE organization_id = ${org.id}
      ORDER BY id DESC LIMIT 1
    `;
		const input = (
			typeof queued.action_input === "string"
				? JSON.parse(queued.action_input)
				: queued.action_input
		) as { escalated_fields?: string[] };
		expect(input.escalated_fields).toEqual(["amount"]);

		// Queueing the card is not the point — APPLYING it is. Approving re-runs
		// the same rule against the same committed state, so without an
		// approved-write signal the rule escalates again and throws, and the card
		// can never be cleared. That dead end shipped in the first cut of this
		// change; this assertion is what would have caught it.
		await applyEntityFieldChangeProposal(
			{
				entity_id: invoice.id,
				fields: result.deferred?.display.fields ?? {},
				current: result.deferred?.display.current ?? {},
				escalated_fields: ["amount"],
				reason: "approved in test",
			} as Parameters<typeof applyEntityFieldChangeProposal>[0],
			user.id,
		);
		expect((await readMetadata(invoice.id)).amount).toBe(90000);
	}, 60_000);

	it("applies a card carrying an ATTRIBUTE key alongside metadata", async () => {
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });

		// `applyEntityFieldChangeProposal` splits a card in two: metadata goes
		// through `mergeEntityFields`, reserved `$name`/`$parent_id`/`$content` go
		// through `patchEntityRows`. Both revalidate, so both need the
		// approved-write signal — the first cut set it on the metadata half only,
		// and a card mixing the two rolled back whole (the attribute half threw
		// inside the same transaction, taking the metadata half with it).
		const result = await updateEntity(
			invoice.id,
			{ name: "INV-RENAMED", metadata: { amount: 90000 } },
			TEST_ENV,
			agentCtx,
		);

		expect(result.deferred?.display.fields).toMatchObject({
			$name: "INV-RENAMED",
			amount: 90000,
		});

		await applyEntityFieldChangeProposal(
			{
				entity_id: invoice.id,
				fields: result.deferred?.display.fields ?? {},
				current: result.deferred?.display.current ?? {},
				escalated_fields: ["amount"],
				reason: "approved in test",
			} as Parameters<typeof applyEntityFieldChangeProposal>[0],
			user.id,
		);

		// BOTH halves land. Asserting only the metadata half would still pass with
		// the attribute half silently rolled back.
		const sql = getTestDb();
		const [row] = await sql<{ name: string }[]>`
      SELECT name FROM entities WHERE id = ${invoice.id}
    `;
		expect(row.name).toBe("INV-RENAMED");
		expect((await readMetadata(invoice.id)).amount).toBe(90000);
	}, 60_000);

	it("DENIES when the full proposal is illegal too, even though a field was held", async () => {
		const { org, user, agent, invoice } = await seed();

		// A HUMAN moves draft -> issued, claiming ownership of `status`.
		await updateEntity(
			invoice.id,
			{ metadata: { status: "issued" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		// The agent now proposes an ILLEGAL move (`issued -> draft`) plus a field.
		// `status` is held, so the residual fails — but so does the full proposal.
		// Deferring here would mint a card that can never be applied: approving
		// replays `issued -> draft`, the rule denies it again, and the write
		// throws forever. The hold is only allowed to rescue a write that was
		// legal as proposed.
		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { status: "draft", einvoice_uuid: "uuid-xyz" } },
				TEST_ENV,
				ctxFor(org.id, { agentId: agent.agentId }),
			),
		).rejects.toThrow(/cannot move issued -> draft/);

		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("issued");
		expect(after.einvoice_uuid ?? null).toBeNull();
	}, 60_000);

	it("DENIES when the residual ESCALATES but the full proposal is illegal", async () => {
		const { org, user, agent, invoice } = await seed(escalateResidualCompiled);

		// A HUMAN moves draft -> issued, claiming ownership of `status`.
		await updateEntity(
			invoice.id,
			{ metadata: { status: "issued" } },
			TEST_ENV,
			ctxFor(org.id, { userId: user.id }),
		);

		// `status` is held, so the residual is `{ amount: 90000 }` — which the rule
		// ESCALATES (over 50k) rather than denying. The full proposal, though, also
		// moves `issued -> draft`, which the rule DENIES.
		//
		// Deferring on the escalate would mint a card that can never be cleared:
		// approving replays the full proposal with the granted fields, which
		// skips the escalate and then hits the deny. The deny branch already
		// guarded against this; the escalate branch did not.
		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { status: "draft", amount: 90000 } },
				TEST_ENV,
				ctxFor(org.id, { agentId: agent.agentId }),
			),
		).rejects.toThrow(/cannot move issued -> draft/);

		const after = await readMetadata(invoice.id);
		expect(after.status).toBe("issued");
		expect(after.amount ?? null).toBeNull();
	}, 60_000);

	it("does NOT wave through an escalation the approver never saw", async () => {
		const sql = getTestDb();
		const { org, user, agent, invoice } = await seed();
		const agentCtx = ctxFor(org.id, { agentId: agent.agentId });

		// The card is minted for `amount` — that is what the human reviews.
		const result = await updateEntity(
			invoice.id,
			{ metadata: { amount: 90000 } },
			TEST_ENV,
			agentCtx,
		);
		expect(result.deferred?.display.fields).toEqual({ amount: 90000 });

		// The rule is redeployed before anyone approves. It now escalates a
		// DIFFERENT field, which no card ever showed to a human.
		await sql`
      UPDATE entity_types SET rules_compiled = ${escalateVendorCompiled}
      WHERE organization_id = ${org.id} AND slug = 'invoice'
    `;

		// Approving must not bless it. An approval is consent to what was on the
		// card, not a blanket waiver of every escalation the rule can raise.
		await expect(
			applyEntityFieldChangeProposal(
				{
					entity_id: invoice.id,
					fields: result.deferred?.display.fields ?? {},
					current: result.deferred?.display.current ?? {},
					escalated_fields: ["amount"],
					reason: "approved in test",
				} as Parameters<typeof applyEntityFieldChangeProposal>[0],
				user.id,
			),
		).rejects.toThrow(/vendor/);

		expect((await readMetadata(invoice.id)).amount ?? null).toBeNull();
	}, 60_000);

	it("still DENIES outright when nothing was held and the caller's own proposal is illegal", async () => {
		const { org, agent, invoice } = await seed();

		// Deferring here would be the over-correction: no hold split anything and
		// no rule asked for review, so the agent simply proposed something illegal.
		await expect(
			updateEntity(
				invoice.id,
				{ metadata: { status: "posted" } },
				TEST_ENV,
				ctxFor(org.id, { agentId: agent.agentId }),
			),
		).rejects.toThrow(/cannot move draft -> posted/);

		expect((await readMetadata(invoice.id)).status).toBe("draft");
	}, 60_000);
});
