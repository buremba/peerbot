/**
 * manage_feeds create_feed / update_feed — cross-org entity_ids validation.
 *
 * Regression (found in prod lobu-crm): feeds were created with `entity_ids`
 * pointing at an entity owned by a DIFFERENT org. The create/update path did
 * not validate entity ownership, so synced events linked to a non-existent
 * in-org entity — a silent data-correctness bug. The fix rejects any entity_id
 * that does not belong to the requesting org.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";
import { TestApiClient } from "../setup/test-mcp-client";

describe("manage_feeds cross-org entity_ids", () => {
	let owner: TestApiClient;
	let ownerOrgId: string;
	let connectionId: number;
	let inOrgEntityId: number;
	let foreignEntityId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();

		const org = await createTestOrganization({ name: "Feed Owner Org" });
		ownerOrgId = org.id;
		const user = await createTestUser({ email: "feed-owner@test.com" });
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});

		const conn = await createTestConnection({
			organization_id: ownerOrgId,
			connector_key: "github",
			created_by: user.id,
			createDefaultFeed: false,
		});
		connectionId = Number(conn.id);

		const inOrg = await createTestEntity({
			name: "In-Org Entity",
			entity_type: "company",
			organization_id: ownerOrgId,
			created_by: user.id,
		});
		inOrgEntityId = Number(inOrg.id);

		// A separate org owns the "foreign" entity.
		const foreignOrg = await createTestOrganization({ name: "Foreign Org" });
		const foreignEntity = await createTestEntity({
			name: "Foreign Entity",
			entity_type: "company",
			organization_id: foreignOrg.id,
		});
		foreignEntityId = Number(foreignEntity.id);
	});

	it("rejects create_feed when an entity_id belongs to another org", async () => {
		const result = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "default",
			entity_ids: [foreignEntityId],
		})) as { error?: string; feed?: unknown };

		expect(result.error).toBeTruthy();
		expect(result.error).toContain(String(foreignEntityId));
		expect(result.feed).toBeUndefined();

		// No feed row leaked into the DB.
		const sql = getTestDb();
		const rows = await sql<{ id: number }[]>`
      SELECT id FROM feeds
      WHERE organization_id = ${ownerOrgId} AND ${foreignEntityId} = ANY(entity_ids)
    `;
		expect(rows.length).toBe(0);
	});

	it("accepts create_feed with an in-org entity_id", async () => {
		const result = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "default",
			entity_ids: [inOrgEntityId],
		})) as { error?: string; feed?: { id: number } };

		expect(result.error).toBeUndefined();
		expect(result.feed?.id).toBeDefined();
	});

	it("rejects update_feed that repoints to another org's entity", async () => {
		// Create a clean feed with no entity_ids first.
		const created = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "default",
			display_name: "update-target",
		})) as { feed?: { id: number } };
		const feedId = Number(created.feed?.id);
		expect(feedId).toBeGreaterThan(0);

		const result = (await owner.feeds.update({
			feed_id: feedId,
			entity_ids: [foreignEntityId],
		})) as { error?: string };

		expect(result.error).toBeTruthy();
		expect(result.error).toContain(String(foreignEntityId));

		// The feed's entity_ids were NOT changed.
		const sql = getTestDb();
		const [row] = await sql<{ entity_ids: number[] | null }[]>`
      SELECT entity_ids FROM feeds WHERE id = ${feedId}
    `;
		const ids = Array.isArray(row?.entity_ids)
			? row.entity_ids.map(Number)
			: [];
		expect(ids).not.toContain(foreignEntityId);
	});
});
