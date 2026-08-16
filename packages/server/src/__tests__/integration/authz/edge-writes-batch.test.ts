/** Contract for the shared batch edge writer. */

import { beforeEach, describe, expect, it } from "vitest";
import {
	ensureRelationshipType,
	upsertEdges,
} from "../../../utils/edge-writes";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestEntity,
	createTestOrganization,
} from "../../setup/test-fixtures";

const TYPE_SLUG = "batch_writer_probe";

async function liveEdges(orgId: string, typeId: number) {
	const sql = getTestDb();
	return sql<
		{
			id: number;
			source: string | null;
			metadata: Record<string, unknown> | null;
		}[]
	>`
    SELECT id, source, metadata
    FROM entity_relationships
    WHERE organization_id = ${orgId}
      AND relationship_type_id = ${typeId}
      AND deleted_at IS NULL
    ORDER BY from_entity_id, to_entity_id
  `;
}

describe("upsertEdges", () => {
	let orgId: string;
	let typeId: number;
	let a: number;
	let b: number;
	let c: number;

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Edge Writer Org" });
		orgId = org.id;
		const entity = (name: string) =>
			createTestEntity({ organization_id: orgId, entity_type: "thing", name });
		a = (await entity("A")).id;
		b = (await entity("B")).id;
		c = (await entity("C")).id;
		typeId = await ensureRelationshipType({
			organizationId: orgId,
			slug: TYPE_SLUG,
			name: "Batch writer probe",
			description: "Fixture type",
		});
	});

	it("survives two concurrent writers claiming the same pair", async () => {
		const call = () =>
			upsertEdges({
				db: getTestDb(),
				organizationId: orgId,
				relationshipTypeId: typeId,
				pairs: [{ fromEntityId: a, toEntityId: b }],
				source: "feed",
				confidence: 0.4,
				onConflict: "ignore",
			});

		// Both run against the same live-triple index at once. Without a conflict
		// clause one of these raises 23505 — that is the auto-linker bug.
		const [first, second] = await Promise.all([call(), call()]);

		expect(first.length + second.length).toBe(1);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});

	it("writes a batch and reports what it created", async () => {
		const result = await upsertEdges({
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [
				{ fromEntityId: a, toEntityId: b },
				{ fromEntityId: a, toEntityId: c },
			],
			source: "feed",
			confidence: 1.0,
			onConflict: "ignore",
		});

		expect(result).toHaveLength(2);
		expect(await liveEdges(orgId, typeId)).toHaveLength(2);
	});

	it("reports no new rows on a re-run", async () => {
		const params = {
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [{ fromEntityId: a, toEntityId: b }],
			source: "feed",
			confidence: 1.0,
			onConflict: "ignore" as const,
		};
		await upsertEdges(params);
		const again = await upsertEdges(params);

		expect(again).toHaveLength(0);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});

	it("dedupes within one batch so DO UPDATE cannot hit a row twice", async () => {
		// `ON CONFLICT DO UPDATE` refuses to affect the same row twice in one
		// statement, so an un-deduped batch would raise 21000 here.
		const result = await upsertEdges({
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [
				{ fromEntityId: a, toEntityId: b },
				{ fromEntityId: a, toEntityId: b },
			],
			source: "config",
			confidence: 1.0,
			metadata: { connection_id: "conn-1" },
			onConflict: "update",
		});

		expect(result).toHaveLength(1);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});

	it("refreshes metadata and source on update, and leaves them alone on ignore", async () => {
		const base = {
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [{ fromEntityId: a, toEntityId: b }],
			confidence: 1.0,
		};
		await upsertEdges({
			...base,
			source: "config",
			metadata: { connection_id: "conn-1" },
			onConflict: "update",
		});

		await upsertEdges({
			...base,
			source: "manual",
			metadata: { connection_id: "conn-2" },
			onConflict: "update",
		});
		let rows = await liveEdges(orgId, typeId);
		expect(rows[0].source).toBe("manual");
		expect(rows[0].metadata).toMatchObject({ connection_id: "conn-2" });

		await upsertEdges({
			...base,
			source: "feed",
			metadata: { connection_id: "conn-3" },
			onConflict: "ignore",
		});
		rows = await liveEdges(orgId, typeId);
		expect(rows[0].source).toBe("manual");
		expect(rows[0].metadata).toMatchObject({ connection_id: "conn-2" });
	});

	it("drops a self-edge without failing the rest of the batch", async () => {
		const created = await upsertEdges({
			db: getTestDb(),
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [
				{ fromEntityId: a, toEntityId: a },
				{ fromEntityId: a, toEntityId: b },
			],
			source: "feed",
			confidence: 1.0,
			onConflict: "ignore",
		});

		expect(created).toHaveLength(1);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});

	it("writes a fresh live row beside a tombstone rather than reviving it", async () => {
		const sql = getTestDb();
		const params = {
			db: sql,
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: [{ fromEntityId: a, toEntityId: b }],
			source: "config",
			confidence: 1.0,
			metadata: { connection_id: "conn-1" },
			onConflict: "update" as const,
		};
		const first = await upsertEdges(params);
		await sql`
      UPDATE entity_relationships
      SET deleted_at = current_timestamp
      WHERE id = ${first[0]}
    `;

		// The conflict target is the PARTIAL live-triple index, so a tombstoned
		// row is not a conflict at all and cannot be revived by the update branch.
		const second = await upsertEdges(params);
		expect(second).toHaveLength(1);
		expect(second[0]).not.toBe(first[0]);
		expect(await liveEdges(orgId, typeId)).toHaveLength(1);
	});
});
