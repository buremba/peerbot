/**
 * `automations.managed_agent_id` is the sole principal-ownership edge the entity
 * mutation gate folds, and `resolveAutomationOwner` reads it as a two-state
 * field: NULL means "no managed agent" (still a valid principal, no ancestor),
 * and any other value MUST name a live agent or the write fails closed.
 *
 * The empty string was a third state that behaved like neither. It slipped past
 * the NULL branch, missed the `agents` lookup, and resolved `false` — so every
 * declared entity output of that Automation was silently denied while
 * `complete_window` still reported success. One production Automation sat in
 * that state for eleven days.
 *
 * `automations_managed_agent_id_nonempty` removes the third state at the
 * storage layer, which is also what lets the resolver keep its cheap `IS NULL`
 * test. These tests pin both halves: the constraint rejects '', and the two
 * remaining states resolve the way the gate expects.
 */

import { describe, expect, it } from "vitest";
import { resolveAutomationOwner } from "../../../authz/entity-policy";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

async function insertAutomation(
	organizationId: string,
	createdBy: string,
	managedAgentId: string | null,
	slug: string,
): Promise<number> {
	const sql = getTestDb();
	// automation_group_id is NOT NULL and self-references the row, and id is
	// serial — take the next id first so both match, like the CRUD does.
	const [{ nextid }] = await sql<{ nextid: number }[]>`
		SELECT nextval('automations_id_seq') AS nextid
	`;
	const id = Number(nextid);
	await sql`
		INSERT INTO automations (
			id, organization_id, slug, name, managed_agent_id,
			created_by, automation_group_id, created_at, updated_at
		) VALUES (
			${id}, ${organizationId}, ${slug}, ${slug}, ${managedAgentId},
			${createdBy}, ${id}, NOW(), NOW()
		)
	`;
	return id;
}

async function seed() {
	const sql = getTestDb();
	const org = await createTestOrganization({ name: "Managed Agent Owner Org" });
	// automations.created_by carries an FK to "user"; a real row is required or
	// the FK fires before the constraint under test.
	const user = await createTestUser();
	const agent = await createTestAgent({
		organizationId: org.id,
		ownerUserId: user.id,
	});
	return { sql, org, createdBy: user.id, agent };
}

describe("automations.managed_agent_id owner resolution", () => {
	it("stores no empty-string owner: the CHECK rejects it on insert", async () => {
		const { org, createdBy } = await seed();
		try {
			await expect(
				insertAutomation(org.id, createdBy, "", "empty-owner-insert"),
			).rejects.toThrow(/automations_managed_agent_id_nonempty/);
		} finally {
			await cleanupTestDatabase();
		}
	});

	it("stores no empty-string owner: the CHECK rejects it on update", async () => {
		const { sql, org, createdBy } = await seed();
		try {
			const id = await insertAutomation(
				org.id,
				createdBy,
				null,
				"empty-owner-update",
			);
			await expect(
				sql`UPDATE automations SET managed_agent_id = '' WHERE id = ${id}`,
			).rejects.toThrow(/automations_managed_agent_id_nonempty/);
		} finally {
			await cleanupTestDatabase();
		}
	});

	it("resolves a NULL owner as owner-less but RESOLVED (the open manual lane)", async () => {
		const { org, createdBy } = await seed();
		try {
			const id = await insertAutomation(
				org.id,
				createdBy,
				null,
				"null-owner-resolves",
			);
			const owner = await resolveAutomationOwner(getTestDb(), id, org.id);
			// resolved:true is what keeps the gate from denying every write an
			// unowned manual Automation makes — the state prod's '' row broke.
			expect(owner).toEqual({ ownerAgentId: null, resolved: true });
		} finally {
			await cleanupTestDatabase();
		}
	});

	it("resolves a live managed agent as the folded ancestor", async () => {
		const { org, createdBy, agent } = await seed();
		try {
			const id = await insertAutomation(
				org.id,
				createdBy,
				agent.agentId,
				"live-owner-resolves",
			);
			const owner = await resolveAutomationOwner(getTestDb(), id, org.id);
			expect(owner).toEqual({
				ownerAgentId: agent.agentId,
				resolved: true,
			});
		} finally {
			await cleanupTestDatabase();
		}
	});

	it("still FAILS CLOSED on an owner that names no live agent", async () => {
		const { org, createdBy } = await seed();
		try {
			const id = await insertAutomation(
				org.id,
				createdBy,
				"agent-deleted-out-from-under-it",
				"dangling-owner-denies",
			);
			const owner = await resolveAutomationOwner(getTestDb(), id, org.id);
			expect(owner.resolved).toBe(false);
		} finally {
			await cleanupTestDatabase();
		}
	});

	it("fails closed when the Automation row itself is gone", async () => {
		const { org } = await seed();
		try {
			const owner = await resolveAutomationOwner(getTestDb(), 2_000_000_001, org.id);
			expect(owner).toEqual({ ownerAgentId: null, resolved: false });
		} finally {
			await cleanupTestDatabase();
		}
	});
});
