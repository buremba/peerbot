/**
 * Write rules at the MERGE kernel.
 *
 * `deleteEntity` has been rule-governed since #2932, but `deleteEntity` is not
 * the only writer of `entities.deleted_at`: `transitionEntityMergeRows`
 * tombstones the losing row of a merge and asked nobody. A rule that freezes a
 * row therefore stopped the delete and not the merge, which is the difference
 * between a control and a suggestion.
 *
 * Merge gets its OWN reserved name rather than borrowing `$deleted`. Merging a
 * duplicate into its canonical record is a correction, not a destruction, and a
 * tenant must be able to freeze deletion without freezing dedupe. The
 * discriminating test below is the one that proves the two are separable.
 *
 * Scope: the LOSER's tombstone only. The winner's metadata patch, the redirect
 * repoint, and unmerge are declared exemptions with their reasons spelled out on
 * `transitionEntityMergeRows` in `entity-management.ts`.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileEntityRule } from "../../../authz/entity-rule-executor";
import type { Env } from "../../../index";
import type { ToolContext } from "../../../tools/registry";
import {
	applyEntityChangeProposal,
	proposeEntityMerge,
} from "../../../tools/admin/entity-field-approval";
import { manageEntity } from "../../../tools/admin/manage_entity";
import { createEntity } from "../../../utils/entity-management";
import {
	applyMerge,
	applyMergeGroup,
	applyUnmerge,
} from "../../../utils/entity-merge";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { initWorkspaceProvider } from "../../../workspace";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

/** Blocks the merge itself, naming the merge — not the tombstone it implies. */
const DENY_MERGE_RULE = `
export default (row) => {
  if (row.op === "update" && row.changed("$merged_into") && row.next.$merged_into) {
    row.deny("a posted invoice cannot be merged away");
  }
};
`;

/**
 * The SEPARATION probe: freezes deletion and says nothing about merging. If
 * merge reuses `$deleted`, this rule blocks a legitimate dedupe of a
 * double-entered invoice — the exact false positive the reserved name avoids.
 */
const DENY_DELETE_ONLY_RULE = `
export default (row) => {
  if (row.op === "update" && row.changed("$deleted") && row.next.$deleted) {
    row.deny("a posted invoice cannot be deleted");
  }
};
`;

/** Asks for review of the merge, so the grant on the approval replay is exercised. */
const ESCALATE_MERGE_RULE = `
export default (row) => {
  if (row.op === "update" && row.changed("$merged_into") && row.next.$merged_into) {
    row.escalate(["$merged_into"], "a merge needs a second pair of eyes");
  }
};
`;

/**
 * Freezes either direction of the loser topology transition. Installed only
 * after the merge, so the test can prove recovery is not stranded by a later
 * rule that would reject clearing `$merged_into` if unmerge reached the seam.
 */
const FREEZE_MERGE_TOPOLOGY_RULE = `
export default (row) => {
  if (row.op === "update" && row.changed("$merged_into")) {
    row.deny("merge topology is frozen");
  }
};
`;

const TEST_ENV = {} as Env;

function ctxFor(organizationId: string, userId: string): ToolContext {
	return {
		organizationId,
		userId,
		memberRole: "owner",
		agentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		scopedToOrg: true,
		allowCrossOrg: false,
	} as unknown as ToolContext;
}

let denyMergeCompiled: string;
let denyDeleteOnlyCompiled: string;
let escalateMergeCompiled: string;
let freezeMergeTopologyCompiled: string;

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

async function readRow(id: number) {
	const sql = getTestDb();
	const rows = await sql<
		{ deleted_at: Date | null; merged_into: string | number | null }[]
	>`
    SELECT deleted_at, merged_into FROM entities WHERE id = ${id}
  `;
	const row = rows[0];
	// bigint comes back as text on one driver path and a number on the other.
	return {
		deleted_at: row.deleted_at,
		merged_into: row.merged_into == null ? null : Number(row.merged_into),
	};
}

/**
 * An org with a ruled `invoice` type and `count` invoices in it. Creates run
 * through the real entry point, so a fixture cannot be born in a state its own
 * rule forbids.
 */
async function seedInvoices(rule: string | null, count = 2) {
	const org = await createTestOrganization({ name: "Merge seam" });
	const user = await createTestUser();
	await addUserToOrganization(user.id, org.id, "owner");
	await seedType(org.id, "invoice", rule);

	const invoices = [];
	for (let i = 0; i < count; i++) {
		invoices.push(
			await createEntity({
				entity_type: "invoice",
				name: `INV-${i + 1}`,
				organization_id: org.id,
				created_by: user.id,
				metadata: { status: "posted", amount: 100 },
			} as Parameters<typeof createEntity>[0]),
		);
	}
	return { org, user, invoices };
}

describe("write rules at the merge kernel", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
		[
			denyMergeCompiled,
			denyDeleteOnlyCompiled,
			escalateMergeCompiled,
			freezeMergeTopologyCompiled,
		] = await Promise.all([
				compileEntityRule(DENY_MERGE_RULE),
				compileEntityRule(DENY_DELETE_ONLY_RULE),
				compileEntityRule(ESCALATE_MERGE_RULE),
				compileEntityRule(FREEZE_MERGE_TOPOLOGY_RULE),
			]);
	}, 60_000);

	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("blocks a merge when a rule denies $merged_into", async () => {
		const { org, user, invoices } = await seedInvoices(denyMergeCompiled);
		const [loser, winner] = invoices;

		await expect(
			applyMerge({
				orgId: org.id,
				loserId: loser.id,
				winnerId: winner.id,
				mergedBy: user.id,
			}),
		).rejects.toThrow(/cannot be merged away/);

		// The whole transaction rolled back: no tombstone, no redirect.
		const after = await readRow(loser.id);
		expect(after.deleted_at).toBeNull();
		expect(after.merged_into).toBeNull();
	}, 60_000);

	it("allows a merge when the rule only freezes $deleted", async () => {
		// THE SEPARATION PROOF. Deleting this invoice is forbidden; merging a
		// duplicate into its canonical record is a correction and must still work.
		const { org, user, invoices } = await seedInvoices(denyDeleteOnlyCompiled);
		const [loser, winner] = invoices;

		await applyMerge({
			orgId: org.id,
			loserId: loser.id,
			winnerId: winner.id,
			mergedBy: user.id,
		});

		const after = await readRow(loser.id);
		expect(after.deleted_at).not.toBeNull();
		expect(after.merged_into).toBe(winner.id);
	}, 60_000);

	it("keeps unmerge available after a later rule freezes $merged_into", async () => {
		const sql = getTestDb();
		const { org, user, invoices } = await seedInvoices(null, 3);
		const [loser, winner, third] = invoices;

		await applyMerge({
			orgId: org.id,
			loserId: loser.id,
			winnerId: winner.id,
			mergedBy: user.id,
		});
		expect((await readRow(loser.id)).merged_into).toBe(winner.id);

		// A rule introduced after the merge must not strand its tombstoned loser.
		// Unmerge is the recovery path, so it deliberately bypasses row rules.
		await sql`
			UPDATE entity_types
			SET rules_compiled = ${freezeMergeTopologyCompiled}
			WHERE organization_id = ${org.id} AND slug = 'invoice'
		`;

		// Liveness guard: the freeze must actually bind at the seam, or the
		// unmerge below succeeds vacuously rather than by exemption.
		await expect(
			applyMerge({
				orgId: org.id,
				loserId: third.id,
				winnerId: winner.id,
				mergedBy: user.id,
			}),
		).rejects.toThrow(/frozen/);

		await applyUnmerge({
			orgId: org.id,
			loserId: loser.id,
			unmergedBy: user.id,
		});

		const recovered = await readRow(loser.id);
		expect(recovered.deleted_at).toBeNull();
		expect(recovered.merged_into).toBeNull();
	}, 60_000);

	it("fails a whole group and names the offending loser", async () => {
		const { org, user, invoices } = await seedInvoices(denyMergeCompiled, 3);
		const [loserA, loserB, winner] = invoices;

		const err = await applyMergeGroup({
			orgId: org.id,
			loserIds: [loserA.id, loserB.id],
			winnerId: winner.id,
			mergedBy: user.id,
		}).catch((e: unknown) => e as Error);

		expect(err).toBeInstanceOf(Error);
		// Naming the row is what makes a wedged resolution batch diagnosable.
		expect(err.message).toMatch(new RegExp(`\\b${loserA.id}\\b`));

		// Atomic: the second loser is untouched even though its own merge was legal.
		for (const id of [loserA.id, loserB.id]) {
			const after = await readRow(id);
			expect(after.deleted_at).toBeNull();
			expect(after.merged_into).toBeNull();
		}
	}, 60_000);

	it("applies a merge a human approved, waiving the escalate it asked for", async () => {
		const { org, user, invoices } = await seedInvoices(escalateMergeCompiled);
		const [loser, winner] = invoices;

		// Unapproved: the rule asks for review and the merge fails closed.
		await expect(
			applyMerge({
				orgId: org.id,
				loserId: loser.id,
				winnerId: winner.id,
				mergedBy: user.id,
			}),
		).rejects.toThrow(/second pair of eyes/);

		// Approved: the grant covers exactly the field the card was minted for.
		await applyMergeGroup({
			orgId: org.id,
			loserIds: [loser.id],
			winnerId: winner.id,
			mergedBy: user.id,
			approvedFields: ["$merged_into"],
		});

		const after = await readRow(loser.id);
		expect(after.merged_into).toBe(winner.id);
	}, 60_000);

	it("applies an approved merge CARD through the real propose->persist->apply path", async () => {
		// The direct-call test above proves the kernel honours a grant. This one
		// proves the approval path actually SENDS the right one: swap the literal
		// in `entity-field-approval.ts` and only this test notices.
		const sql = getTestDb();
		const { org, user, invoices } = await seedInvoices(escalateMergeCompiled);
		const [loser, winner] = invoices;
		const ctx = ctxFor(org.id, user.id);

		await proposeEntityMerge(
			ctx,
			{
				entity_ids: [loser.id],
				winner_entity_id: winner.id,
			} as Parameters<typeof proposeEntityMerge>[1],
			[
				{ id: loser.id, keys: { name: ["inv-1"] } },
				{ id: winner.id, keys: { name: ["inv-2"] } },
			],
		);

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
		expect(proposal.operation).toBe("merge");

		// Applied inside a transaction, because that is what production does.
		await sql.begin(async (tx) => {
			await applyEntityChangeProposal(proposal as never, ctx, TEST_ENV, tx);
		});

		const after = await readRow(loser.id);
		expect(after.merged_into).toBe(winner.id);
	}, 60_000);

	it("previews a rule refusal on a dry run, mutating nothing", async () => {
		// Without this, the first anyone learns a merge is blocked is a failed 409.
		const { org, user, invoices } = await seedInvoices(denyMergeCompiled);
		const [loser, winner] = invoices;

		const res = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
				dry_run: true,
			} as Parameters<typeof manageEntity>[0],
			TEST_ENV,
			ctxFor(org.id, user.id),
		)) as Record<string, unknown>;

		expect(res.dry_run).toBe(true);
		expect(res.message).toMatch(/would NOT be applied/);
		expect(res.message).toMatch(/cannot be merged away/);

		// A preview enforces nothing AND mutates nothing.
		const after = await readRow(loser.id);
		expect(after.deleted_at).toBeNull();
		expect(after.merged_into).toBeNull();
	}, 60_000);

	it("says a legal merge would be applied, and still does not apply it", async () => {
		const { org, user, invoices } = await seedInvoices(denyDeleteOnlyCompiled);
		const [loser, winner] = invoices;

		const res = (await manageEntity(
			{
				action: "merge",
				entity_id: loser.id,
				winner_entity_id: winner.id,
				dry_run: true,
			} as Parameters<typeof manageEntity>[0],
			TEST_ENV,
			ctxFor(org.id, user.id),
		)) as Record<string, unknown>;

		expect(res.message).toMatch(/would be applied/);
		expect(res.message).not.toMatch(/would NOT be applied/);
		expect((await readRow(loser.id)).merged_into).toBeNull();
	}, 60_000);

	it("leaves an unruled type exactly as cheap as before", async () => {
		const { org, user, invoices } = await seedInvoices(null);
		const [loser, winner] = invoices;

		await applyMerge({
			orgId: org.id,
			loserId: loser.id,
			winnerId: winner.id,
			mergedBy: user.id,
		});

		expect((await readRow(loser.id)).merged_into).toBe(winner.id);
	}, 60_000);
});
