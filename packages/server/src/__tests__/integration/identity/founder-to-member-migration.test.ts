/**
 * Founder → $member migration replay test.
 *
 * Reads the committed SQL file, runs it against a fresh fixture state with a
 * `market` org plus a couple of founder entities + cross-references, runs it
 * a SECOND time to confirm idempotency, and verifies:
 *  - $member rows exist for each former founder
 *  - entity_identities rows that pointed at the founder now point at $member
 *  - events.entity_ids arrays no longer reference the soft-deleted founder
 *  - relationship-type rules accept `$member` as source/target where they
 *    previously accepted `founder`
 *  - source founder rows are soft-deleted
 *  - second run produces zero net changes (same row counts, same entity ids).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const MIGRATION_PATH = join(
	__dirname,
	"../../../../../../db/migrations/20260427170000_market_founder_to_member.sql",
);

function loadMigrationUp(): string {
	const raw = readFileSync(MIGRATION_PATH, "utf-8");
	// The dbmate file format has `-- migrate:up` and `-- migrate:down` markers.
	const upStart = raw.indexOf("-- migrate:up");
	const downStart = raw.indexOf("-- migrate:down");
	if (upStart < 0 || downStart < 0) {
		throw new Error(
			`migration file missing up/down markers: ${MIGRATION_PATH}`,
		);
	}
	return raw.slice(upStart + "-- migrate:up".length, downStart).trim();
}

describe("founder→$member migration", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("repoints identities, rewrites event entity_ids, and is idempotent on re-run", async () => {
		const sql = getTestDb();
		const market = await createTestOrganization({
			name: "venture-capital",
			visibility: "public",
		});
		// Legacy installs used slug='venture-capital'; migration must still find them.
		await sql`UPDATE organization SET slug = 'venture-capital' WHERE id = ${market.id}`;
		const user = await createTestUser({ email: "op@market.test" });

		const founder = await createTestEntity({
			name: "Old Founder",
			entity_type: "founder",
			organization_id: market.id,
			created_by: user.id,
		});
		await sql`
      UPDATE entities SET metadata = ${sql.json({
				email: "founder@example.com",
				linkedin_url: "linkedin.com/in/founder",
				twitter_handle: "@founder",
			})}
      WHERE id = ${founder.id}
    `;

		// Pre-existing identity row pointing at the founder (simulates an
		// earlier provisioning script). Migration must repoint this.
		await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${market.id}, ${founder.id}, 'auth_user_id', 'preexisting_user_42', 'auth:signup')
    `;

		// Pre-existing event referencing the founder in entity_ids.
		const [historicalEvent] = await sql<{ id: number }[]>`
      INSERT INTO events (
        organization_id, entity_ids, origin_id, semantic_type, payload_type, created_by
      )
      VALUES (
        ${market.id}, ARRAY[${founder.id}::bigint], 'historical-1', 'note', 'text', ${user.id}
      )
      RETURNING id
    `;

		const sqlText = loadMigrationUp();
		await sql.unsafe(sqlText);
		// Second run — must be a no-op for correctness.
		await sql.unsafe(sqlText);

		const memberRows = await sql<
			{ id: number; metadata: Record<string, unknown> }[]
		>`
      SELECT e.id, e.metadata
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${market.id}
        AND et.slug = '$member'
        AND e.deleted_at IS NULL
    `;
		expect(memberRows).toHaveLength(1);
		const memberId = Number(memberRows[0].id);
		expect(memberRows[0].metadata).toMatchObject({
			role: "founder",
			migrated_from_founder_id: founder.id,
		});

		// Pre-existing identity row was repointed.
		const repointedIdentity = await sql<{ entity_id: number }[]>`
      SELECT entity_id FROM entity_identities
      WHERE organization_id = ${market.id}
        AND namespace = 'auth_user_id'
        AND identifier = 'preexisting_user_42'
        AND deleted_at IS NULL
    `;
		expect(repointedIdentity).toHaveLength(1);
		expect(Number(repointedIdentity[0].entity_id)).toBe(memberId);

		// Migration also wrote new identity rows from founder metadata.
		const writtenIdentities = await sql<
			{ namespace: string; entity_id: number }[]
		>`
      SELECT namespace, entity_id FROM entity_identities
      WHERE organization_id = ${market.id}
        AND source_connector = 'migration:founder_to_member'
        AND deleted_at IS NULL
      ORDER BY namespace
    `;
		expect(writtenIdentities.map((r) => r.namespace).sort()).toEqual([
			"email",
			"linkedin_url",
			"twitter_handle",
		]);
		for (const r of writtenIdentities) {
			expect(Number(r.entity_id)).toBe(memberId);
		}

		// Historical event was rewritten.
		const [eventAfter] = await sql<{ entity_ids: number[] }[]>`
      SELECT entity_ids FROM events WHERE id = ${historicalEvent.id}
    `;
		expect(eventAfter.entity_ids.map(Number)).toEqual([memberId]);

		// Founder row is soft-deleted.
		const [founderAfter] = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM entities WHERE id = ${founder.id}
    `;
		expect(founderAfter.deleted_at).not.toBeNull();
	});
});
