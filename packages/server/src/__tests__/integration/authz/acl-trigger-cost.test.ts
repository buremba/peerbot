/**
 * What the chokepoint trigger costs on the common (unclassified) path.
 *
 * It fires per row on every `entity_relationships` write, and `upsertEdges`
 * writes whole batches in one statement, so "one PK lookup" is multiplied by
 * batch size. Measured rather than assumed: an unclassified type pays the
 * lookup and returns early, which is the common path for every domain edge in
 * the system.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { upsertEdges } from "../../../utils/edge-writes";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestEntity,
	createTestOrganization,
} from "../../setup/test-fixtures";

const BATCH = 500;

describe("chokepoint trigger cost", () => {
	let orgId: string;
	let typeId: number;
	let hub: number;
	let spokes: number[];

	beforeEach(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Cost Org" });
		orgId = org.id;
		const sql = getTestDb();
		const t = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types
        (slug, name, organization_id, created_at, updated_at)
      VALUES ('perf_probe', 'Perf probe', ${orgId}, current_timestamp, current_timestamp)
      RETURNING id
    `;
		typeId = Number(t[0].id);
		hub = (
			await createTestEntity({
				organization_id: orgId,
				entity_type: "thing",
				name: "hub",
			})
		).id;
		spokes = [];
		for (let i = 0; i < BATCH; i++) {
			spokes.push(
				(
					await createTestEntity({
						organization_id: orgId,
						entity_type: "thing",
						name: `spoke-${i}`,
					})
				).id,
			);
		}
	});

	async function timeBatch(): Promise<number> {
		const sql = getTestDb();
		await sql`DELETE FROM entity_relationships WHERE relationship_type_id = ${typeId}`;
		const started = process.hrtime.bigint();
		await upsertEdges({
			db: sql,
			organizationId: orgId,
			relationshipTypeId: typeId,
			pairs: spokes.map((s) => ({ fromEntityId: hub, toEntityId: s })),
			source: "feed",
			onConflict: "ignore",
		});
		return Number(process.hrtime.bigint() - started) / 1e6;
	}

	it(`writes ${BATCH} unclassified edges through the trigger`, async () => {
		const sql = getTestDb();

		// Warm, then measure with the trigger in place.
		await timeBatch();
		const withTrigger = Math.min(await timeBatch(), await timeBatch());

		let without: number;
		try {
			await sql`DROP TRIGGER IF EXISTS lobu_guard_authorization_edges ON entity_relationships`;
			await timeBatch();
			without = Math.min(await timeBatch(), await timeBatch());
		} finally {
			// Restore even if the measurement throws. Without the finally a
			// failure here silently disarms the chokepoint for every test that
			// runs after it in the same database.
			await sql`
        CREATE TRIGGER lobu_guard_authorization_edges
        BEFORE INSERT OR UPDATE OR DELETE ON entity_relationships
        FOR EACH ROW EXECUTE FUNCTION lobu_guard_authorization_edges()
      `;
		}

		const overheadPct = ((withTrigger - without) / without) * 100;
		// eslint-disable-next-line no-console
		console.log(
			`${BATCH} edges — with trigger ${withTrigger.toFixed(1)}ms, ` +
				`without ${without.toFixed(1)}ms, overhead ${overheadPct.toFixed(0)}%`,
		);

		// Wall-clock noise makes this threshold deliberately broad; it only fails a
		// catastrophic regression of roughly an order of magnitude.
		expect(withTrigger).toBeLessThan(without * 10 + 50);
	});
});
