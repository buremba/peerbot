import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getTestDb } from "../../setup/test-db";
import { cleanupTestDatabase } from "../../setup/test-db";
import { createTestOrganization } from "../../setup/test-fixtures";

/**
 * The /permissions type list must include public-catalog types (visibility=
 * 'public') the org can write entities for, deduped by slug (org-owned wins),
 * $member excluded. This exercises the exact query the endpoint runs.
 */
async function listTypes(orgId: string) {
	const sql = getTestDb();
	return sql<{ slug: string; name: string }>`
    SELECT slug, name FROM (
      SELECT DISTINCT ON (et.slug) et.slug, et.name
      FROM entity_types et
      LEFT JOIN organization o ON o.id = et.organization_id
      WHERE et.deleted_at IS NULL
        AND et.slug <> '$member'
        AND (et.organization_id = ${orgId} OR o.visibility = 'public')
      ORDER BY et.slug, (et.organization_id = ${orgId}) DESC, et.id ASC
    ) t
    ORDER BY name ASC
  `;
}

describe("/permissions catalog type resolution", () => {
	afterAll(async () => {
		await cleanupTestDatabase();
	});

	let orgId: string;
	let publicOrgId: string;
	beforeEach(async () => {
		const org = await createTestOrganization();
		orgId = org.id;
		const pub = await createTestOrganization();
		publicOrgId = pub.id;
		await getTestDb()`
      UPDATE organization SET visibility = 'public' WHERE id = ${publicOrgId}
    `;
	});

	it("includes a public-catalog type the org does not own", async () => {
		await getTestDb()`
      INSERT INTO entity_types (organization_id, slug, name)
      VALUES (${publicOrgId}, 'company', 'Company')
    `;
		const types = await listTypes(orgId);
		expect(types.map((t) => t.slug)).toContain("company");
	});

	it("dedupes by slug, preferring the org-owned row", async () => {
		await getTestDb()`
      INSERT INTO entity_types (organization_id, slug, name)
      VALUES (${publicOrgId}, 'thing', 'Public Thing'),
             (${orgId}, 'thing', 'My Thing')
    `;
		const types = await listTypes(orgId);
		const thing = types.filter((t) => t.slug === "thing");
		expect(thing).toHaveLength(1);
		expect(thing[0].name).toBe("My Thing");
	});

	it("excludes $member even from public catalogs", async () => {
		await getTestDb()`
      INSERT INTO entity_types (organization_id, slug, name)
      VALUES (${publicOrgId}, '$member', 'Member')
    `;
		const types = await listTypes(orgId);
		expect(types.map((t) => t.slug)).not.toContain("$member");
	});
});
