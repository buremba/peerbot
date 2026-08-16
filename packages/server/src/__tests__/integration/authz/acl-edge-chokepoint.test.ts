/**
 * The database-level chokepoint for authorization-bearing edges.
 *
 * Call-site checks are not enough because a new or overlooked SQL writer could
 * route around them. These cases cover every mutation shape plus the privileged
 * materializer and merge lifecycle.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemberOfType } from "../../../authz/access-graph";
import { applyMerge, applyUnmerge } from "../../../utils/entity-merge";
import {
	withAclEdgeWrite,
	withAclPrivilege,
} from "../../../utils/relationship-validation";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestEntity,
	createTestOrganization,
} from "../../setup/test-fixtures";

describe("authorization edges have one enforcement point", () => {
	let orgId: string;
	let typeId: number;
	let alice: number;
	let bob: number;
	let channel: number;

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Chokepoint Org" });
		orgId = org.id;
		typeId = await ensureMemberOfType(orgId);
		const mk = (type: string, name: string) =>
			createTestEntity({ organization_id: orgId, entity_type: type, name });
		alice = (await mk("person", "Alice")).id;
		bob = (await mk("person", "Bob")).id;
		channel = (await mk("channel", "#secrets")).id;
		await classifyMemberOf();
	});

	/** The follow-up deployment classifies this in production; these tests arm it. */
	async function classifyMemberOf(): Promise<void> {
		const sql = getTestDb();
		await sql`
      UPDATE entity_relationship_types SET purpose = 'authorization'
      WHERE id = ${typeId}
    `;
	}

	async function seedGrant(person: number): Promise<number> {
		return withAclEdgeWrite(getTestDb(), async (tx) => {
			const rows = await tx<{ id: number }[]>`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id,
           source, created_at, updated_at)
        VALUES (${orgId}, ${person}, ${channel}, ${typeId}, 'feed',
                current_timestamp, current_timestamp)
        RETURNING id
      `;
			return Number(rows[0].id);
		});
	}

	it("the ACL sync itself still works", async () => {
		const id = await seedGrant(alice);
		expect(id).toBeGreaterThan(0);
	});

	it("blocks a raw INSERT that impersonates the sync's own source value", async () => {
		// `source='feed'` is what the ACL syncs write AND is caller-settable, so
		// source can never carry this boundary. The flag can.
		const sql = getTestDb();
		await expect(
			sql`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id,
           source, created_at, updated_at)
        VALUES (${orgId}, ${bob}, ${channel}, ${typeId}, 'feed',
                current_timestamp, current_timestamp)
      `
		).rejects.toThrow(/authorization-bearing/);
	});

	it("blocks the repoint an entity MERGE performs", async () => {
		await seedGrant(alice);
		const sql = getTestDb();
		await expect(
			sql`
        UPDATE entity_relationships
        SET from_entity_id = ${bob}, updated_at = current_timestamp
        WHERE relationship_type_id = ${typeId} AND from_entity_id = ${alice}
      `
		).rejects.toThrow(/authorization-bearing/);
	});

	it("blocks the tombstone an unlink or merge-collision performs", async () => {
		const id = await seedGrant(alice);
		const sql = getTestDb();
		await expect(
			sql`
        UPDATE entity_relationships
        SET deleted_at = current_timestamp
        WHERE id = ${id}
      `
		).rejects.toThrow(/authorization-bearing/);
	});

	it("blocks a hard DELETE that is not the ACL sync's own", async () => {
		const id = await seedGrant(alice);
		const sql = getTestDb();
		await expect(
			sql`DELETE FROM entity_relationships WHERE id = ${id}`
		).rejects.toThrow(/authorization-bearing/);
	});

	it("lets the sync tombstone its own edge when a member leaves", async () => {
		const id = await seedGrant(alice);
		await withAclEdgeWrite(getTestDb(), async (tx) => {
			await tx`
        UPDATE entity_relationships
        SET deleted_at = current_timestamp
        WHERE id = ${id}
      `;
		});
		const sql = getTestDb();
		const live = await sql`
      SELECT id FROM entity_relationships WHERE id = ${id} AND deleted_at IS NULL
    `;
		expect(live).toHaveLength(0);
	});

	it("does not touch ordinary domain edges", async () => {
		const sql = getTestDb();
		const t = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types
        (slug, name, organization_id, created_at, updated_at)
      VALUES ('billed_to', 'Billed to', ${orgId}, current_timestamp, current_timestamp)
      RETURNING id
    `;
		const billedTo = Number(t[0].id);

		const edge = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         source, created_at, updated_at)
      VALUES (${orgId}, ${alice}, ${channel}, ${billedTo}, 'feed',
              current_timestamp, current_timestamp)
      RETURNING id
    `;
		expect(edge).toHaveLength(1);

		// …and every mutation shape stays open on it.
		await sql`
      UPDATE entity_relationships SET confidence = 0.5 WHERE id = ${edge[0].id}
    `;
		await sql`DELETE FROM entity_relationships WHERE id = ${edge[0].id}`;
	});

	it("blocks moving an edge either onto or off an authorization type", async () => {
		const protectedEdgeId = await seedGrant(alice);
		const sql = getTestDb();
		const types = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types
        (slug, name, organization_id, created_at, updated_at)
      VALUES ('ordinary', 'Ordinary', ${orgId}, current_timestamp, current_timestamp)
      RETURNING id
    `;
		const ordinaryTypeId = Number(types[0].id);
		const ordinaryEdges = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         source, created_at, updated_at)
      VALUES (${orgId}, ${bob}, ${channel}, ${ordinaryTypeId}, 'api',
              current_timestamp, current_timestamp)
      RETURNING id
    `;

		await expect(
			sql`
        UPDATE entity_relationships
        SET relationship_type_id = ${ordinaryTypeId}
        WHERE id = ${protectedEdgeId}
      `,
		).rejects.toThrow(/authorization-bearing/);
		await expect(
			sql`
        UPDATE entity_relationships
        SET relationship_type_id = ${typeId}
        WHERE id = ${ordinaryEdges[0].id}
      `,
		).rejects.toThrow(/authorization-bearing/);
	});

	it("a MERGE drops the loser's grants instead of transferring them", async () => {
		// The vulnerability this closes: Alice is in #secrets, Bob is not. Merging
		// Alice into Bob must not hand Bob her access. ACL edges are a projection
		// of provider membership, so the correct outcome is to drop and re-derive.
		await seedGrant(alice);

		const sql = getTestDb();
		const before = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND from_entity_id = ${alice}
        AND deleted_at IS NULL
    `;
		expect(before).toHaveLength(1);

		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);

		const bobGrants = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND from_entity_id = ${bob}
        AND deleted_at IS NULL
    `;
		const aliceGrants = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND from_entity_id = ${alice}
        AND deleted_at IS NULL
    `;

		// Neither party holds the grant afterwards: the next sync decides.
		expect(bobGrants).toHaveLength(0);
		expect(aliceGrants).toHaveLength(0);
	});

	it("an UNMERGE after that merge neither crashes nor restores the grant", async () => {
		// The undo ledger replays an exact prior state, but access is whatever the
		// provider says NOW. If authorization edges were in the ledger, unmerge
		// would both resurrect a revoked grant AND hit the trigger on the UPDATE.
		await seedGrant(alice);
		const sql = getTestDb();

		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);
		await applyUnmerge(
			{ orgId, loserId: alice, unmergedBy: "chokepoint-test" },
			sql,
		);

		const live = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
    `;
		expect(live).toHaveLength(0);
	});

	it("an UNMERGE drops a grant the sync created for the winner mid-merge", async () => {
		// Merge moves the loser's identities onto the winner, so an ACL sync that
		// runs while they are merged resolves the loser's provider identity to the
		// WINNER and grants the winner access. Splitting them again would leave
		// that grant pointing at someone the provider never granted it to, and no
		// ledger entry describes it — it was created after the merge. The only
		// answer that cannot invent access is to drop it and re-derive.
		const sql = getTestDb();
		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);
		// The intervening sync, writing exactly as the materializer does.
		await seedGrant(bob);

		await applyUnmerge(
			{ orgId, loserId: alice, unmergedBy: "chokepoint-test" },
			sql,
		);

		const live = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
    `;
		expect(live).toHaveLength(0);
	});

	it("an UNMERGE of a legacy merge also drops grants created mid-merge", async () => {
		const sql = getTestDb();
		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);
		await seedGrant(bob);
		// Simulate an entity merged before the durable operation ledger existed.
		await sql`
      DELETE FROM entity_merge_operations
      WHERE organization_id = ${orgId} AND loser_entity_id = ${alice}
    `;

		await applyUnmerge(
			{ orgId, loserId: alice, unmergedBy: "chokepoint-test" },
			sql,
		);

		const live = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
    `;
		expect(live).toHaveLength(0);
	});

	it("an UNMERGE survives a ledger written BEFORE the type was classified", async () => {
		// Reproduces the pre-upgrade ledger: the merge happened while the type was
		// ordinary, so the edge was repointed and RECORDED for undo. Classifying it
		// afterwards would make the trigger reject that restore — permanently
		// stranding every historical merge — unless unmerge skips it.
		const sql = getTestDb();
		const legacy = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types
        (slug, name, organization_id, created_at, updated_at)
      VALUES ('legacy_grant', 'Legacy grant', ${orgId},
              current_timestamp, current_timestamp)
      RETURNING id
    `;
		const legacyTypeId = Number(legacy[0].id);
		await sql`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         source, created_at, updated_at)
      VALUES (${orgId}, ${alice}, ${channel}, ${legacyTypeId}, 'feed',
              current_timestamp, current_timestamp)
    `;

		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);
		// The follow-up deploy classifies the type the ledger already references.
		await sql`
      UPDATE entity_relationship_types SET purpose = 'authorization'
      WHERE id = ${legacyTypeId}
    `;

		await applyUnmerge(
			{ orgId, loserId: alice, unmergedBy: "chokepoint-test" },
			sql,
		);

		const live = await sql`
      SELECT id FROM entity_relationships
      WHERE relationship_type_id = ${legacyTypeId} AND deleted_at IS NULL
    `;
		expect(live).toHaveLength(0);
	});

	it("an UNMERGE marks the ACL snapshot stale so an in-flight sync cannot bless it", async () => {
		// Dropping the edges alone loses a race with a sync that already resolved
		// the loser's identity to the winner and writes moments after we commit.
		const sql = getTestDb();
		await sql`
      INSERT INTO authz_source_acl_state
        (organization_id, connection_id, acl_support, freshness_state,
         last_synced_at, created_at, updated_at)
      VALUES (${orgId}, 'conn-under-test', 'full', 'fresh',
              current_timestamp, current_timestamp, current_timestamp)
    `;
		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);
		// The in-flight sync's grant, resolved to the winner while they were merged.
		await seedGrant(bob);
		await applyUnmerge(
			{ orgId, loserId: alice, unmergedBy: "chokepoint-test" },
			sql,
		);

		const rows = await sql<{ freshness_state: string }[]>`
      SELECT freshness_state FROM authz_source_acl_state
      WHERE organization_id = ${orgId}
    `;
		expect(rows[0].freshness_state).toBe("stale");
	});

	it("an UNMERGE invalidates even when it dropped NOTHING", async () => {
		// The race is exactly this ordering: the sync has resolved the identity to
		// the winner but has not yet written the edge, so there is nothing to drop.
		// Counting dropped rows and skipping the invalidation would therefore skip
		// it in precisely the window that needs it.
		const sql = getTestDb();
		await sql`
      INSERT INTO authz_source_acl_state
        (organization_id, connection_id, acl_support, freshness_state,
         last_synced_at, created_at, updated_at)
      VALUES (${orgId}, 'conn-under-test', 'full', 'fresh',
              current_timestamp, current_timestamp, current_timestamp)
    `;
		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);
		await applyUnmerge(
			{ orgId, loserId: alice, unmergedBy: "chokepoint-test" },
			sql,
		);

		const rows = await sql<{ freshness_state: string }[]>`
      SELECT freshness_state FROM authz_source_acl_state
      WHERE organization_id = ${orgId}
    `;
		expect(rows[0].freshness_state).toBe("stale");
	});

	it("costs an ERP-only tenant nothing — there is no ACL state to invalidate", async () => {
		// The availability cost only lands where ACL is actually onboarded. An org
		// that has never graphed a connection has no row, so the statement matches
		// nothing and no visibility is lost.
		const sql = getTestDb();
		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);
		await applyUnmerge(
			{ orgId, loserId: alice, unmergedBy: "chokepoint-test" },
			sql,
		);

		const rows = await sql`
      SELECT 1 FROM authz_source_acl_state WHERE organization_id = ${orgId}
    `;
		expect(rows).toHaveLength(0);
	});

	it("an UNMERGE still restores ORDINARY edges to the loser", async () => {
		// Guards the NULL-safety of the ACL-managed predicate. `purpose` is NULL on
		// every ordinary type, so writing the negation with `=` instead of
		// `IS NOT DISTINCT FROM` makes `NOT (NULL = 'authorization' OR …)` evaluate
		// to NULL — silently dropping ordinary edges from the undo ledger, so an
		// unmerge would leave them stranded on the winner. Nothing else in the
		// suite exercises the restore side.
		const sql = getTestDb();
		const t = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types
        (slug, name, organization_id, created_at, updated_at)
      VALUES ('billed_to', 'Billed to', ${orgId}, current_timestamp, current_timestamp)
      RETURNING id
    `;
		const ordinaryTypeId = Number(t[0].id);
		const edge = await sql<{ id: number }[]>`
      INSERT INTO entity_relationships
        (organization_id, from_entity_id, to_entity_id, relationship_type_id,
         source, created_at, updated_at)
      VALUES (${orgId}, ${alice}, ${channel}, ${ordinaryTypeId}, 'feed',
              current_timestamp, current_timestamp)
      RETURNING id
    `;

		await applyMerge(
			{ orgId, winnerId: bob, loserId: alice, mergedBy: "chokepoint-test" },
			sql,
		);
		const merged = await sql<{ from_entity_id: number }[]>`
      SELECT from_entity_id FROM entity_relationships WHERE id = ${edge[0].id}
    `;
		expect(Number(merged[0].from_entity_id)).toBe(bob);

		await applyUnmerge(
			{ orgId, loserId: alice, unmergedBy: "chokepoint-test" },
			sql,
		);

		const restored = await sql<{ from_entity_id: number }[]>`
      SELECT from_entity_id FROM entity_relationships
      WHERE id = ${edge[0].id} AND deleted_at IS NULL
    `;
		expect(Number(restored[0].from_entity_id)).toBe(alice);
	});

	it("does not leave the ACL privilege set for the rest of the transaction", async () => {
		// Regression: a bare `set_config(...)` with no reset made every later
		// statement in the merge transaction privileged, so the trigger could no
		// longer refuse a repoint of an authorization edge the first statement
		// had not matched.
		const sql = getTestDb();

		await expect(
			sql.begin(async (tx) => {
				await withAclPrivilege(tx as never, async () => {
					await tx`
            INSERT INTO entity_relationships
              (organization_id, from_entity_id, to_entity_id, relationship_type_id,
               source, created_at, updated_at)
            VALUES (${orgId}, ${alice}, ${channel}, ${typeId}, 'feed',
                    current_timestamp, current_timestamp)
          `;
				});
				// Same transaction, privilege dropped — must now be refused.
				await tx`
          INSERT INTO entity_relationships
            (organization_id, from_entity_id, to_entity_id, relationship_type_id,
             source, created_at, updated_at)
          VALUES (${orgId}, ${bob}, ${channel}, ${typeId}, 'feed',
                  current_timestamp, current_timestamp)
        `;
			}),
		).rejects.toThrow(/authorization-bearing/);
	});

	it("does not leak the flag to the next transaction on a pooled connection", async () => {
		// SET LOCAL is transaction-scoped. If it leaked, a later caller write on the
		// same pooled connection would silently pass.
		await seedGrant(alice);
		const sql = getTestDb();
		await expect(
			sql`
        INSERT INTO entity_relationships
          (organization_id, from_entity_id, to_entity_id, relationship_type_id,
           source, created_at, updated_at)
        VALUES (${orgId}, ${bob}, ${channel}, ${typeId}, 'feed',
                current_timestamp, current_timestamp)
      `
		).rejects.toThrow(/authorization-bearing/);
	});
});
