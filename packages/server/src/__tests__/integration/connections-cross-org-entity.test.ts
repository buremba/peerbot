/**
 * manage_connections update / list — connection↔entity association.
 *
 * Connections can be directly tagged with entities (connections.entity_ids),
 * mirroring feeds. Tagging a connection with an entity owned by a DIFFERENT
 * org would surface the connection under a non-existent in-org entity, so the
 * update path validates entity ownership and rejects any cross-org entity_id
 * (mirrors manage_feeds). The list path resolves a connection's entities as the
 * UNION of its own entity_ids and any of its feeds' entity_ids, so direct tags
 * and feed-derived links both surface under entity_id / entity_names.
 *
 * (The create/connect tool paths run the same `assertEntityIdsInOrg` guard +
 * `entity_ids::bigint[]` insert, but driving them needs an installed connector
 * definition + auth scaffolding; the cross-org guard + tri-state semantics are
 * exercised here through the update path, which shares the helper.)
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

// postgres.js may surface a bigint[] column either as a JS array or as the raw
// Postgres array literal string (e.g. "{1,2}"). Normalize both to number[].
function toIds(raw: number[] | string | null | undefined): number[] {
	if (Array.isArray(raw)) return raw.map(Number);
	if (typeof raw === "string") {
		const inner = raw.replace(/^\{|\}$/g, "").trim();
		return inner === "" ? [] : inner.split(",").map(Number);
	}
	return [];
}

describe("manage_connections entity association", () => {
	let owner: TestApiClient;
	let ownerOrgId: string;
	let inOrgEntityId: number;
	let feedEntityId: number;
	let foreignEntityId: number;
	let taggableConnectionId: number;
	let feedLinkedConnectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();

		const org = await createTestOrganization({ name: "Conn Owner Org" });
		ownerOrgId = org.id;
		const user = await createTestUser({ email: "conn-owner@test.com" });
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});

		inOrgEntityId = Number(
			(
				await createTestEntity({
					name: "Direct Entity",
					entity_type: "company",
					organization_id: ownerOrgId,
					created_by: user.id,
				})
			).id,
		);
		feedEntityId = Number(
			(
				await createTestEntity({
					name: "Feed Entity",
					entity_type: "company",
					organization_id: ownerOrgId,
					created_by: user.id,
				})
			).id,
		);

		// A separate org owns the "foreign" entity.
		const foreignOrg = await createTestOrganization({ name: "Foreign Org" });
		foreignEntityId = Number(
			(
				await createTestEntity({
					name: "Foreign Entity",
					entity_type: "company",
					organization_id: foreignOrg.id,
				})
			).id,
		);

		// Connection with no feed — entity links come only from connection.entity_ids.
		taggableConnectionId = Number(
			(
				await createTestConnection({
					organization_id: ownerOrgId,
					connector_key: "github",
					created_by: user.id,
					createDefaultFeed: false,
				})
			).id,
		);

		// Connection whose default feed is tagged with feedEntityId — its entity
		// link is feed-derived (no direct connection.entity_ids).
		feedLinkedConnectionId = Number(
			(
				await createTestConnection({
					organization_id: ownerOrgId,
					connector_key: "github",
					created_by: user.id,
					entity_ids: [feedEntityId],
				})
			).id,
		);
	});

	it("rejects update when an entity_id belongs to another org", async () => {
		const result = (await owner.connections.update({
			connection_id: taggableConnectionId,
			entity_ids: [foreignEntityId],
		})) as { error?: string };

		expect(result.error).toBeTruthy();
		expect(result.error).toContain(String(foreignEntityId));

		const sql = getTestDb();
		const [row] = await sql<{ entity_ids: number[] | string | null }[]>`
      SELECT entity_ids FROM connections WHERE id = ${taggableConnectionId}
    `;
		expect(toIds(row?.entity_ids)).not.toContain(foreignEntityId);
	});

	it("update sets in-org entity_ids; explicit [] clears them", async () => {
		await owner.connections.update({
			connection_id: taggableConnectionId,
			entity_ids: [inOrgEntityId],
		});

		const sql = getTestDb();
		let [row] = await sql<{ entity_ids: number[] | string | null }[]>`
      SELECT entity_ids FROM connections WHERE id = ${taggableConnectionId}
    `;
		expect(toIds(row?.entity_ids)).toContain(inOrgEntityId);

		// undefined leaves it unchanged...
		await owner.connections.update({
			connection_id: taggableConnectionId,
			display_name: "renamed",
		});
		[row] = await sql<{ entity_ids: number[] | string | null }[]>`
      SELECT entity_ids FROM connections WHERE id = ${taggableConnectionId}
    `;
		expect(toIds(row?.entity_ids)).toContain(inOrgEntityId);

		// ...explicit [] clears.
		await owner.connections.update({
			connection_id: taggableConnectionId,
			entity_ids: [],
		});
		[row] = await sql<{ entity_ids: number[] | string | null }[]>`
      SELECT entity_ids FROM connections WHERE id = ${taggableConnectionId}
    `;
		expect(toIds(row?.entity_ids).length).toBe(0);
	});

	it("lists a connection under its directly-tagged entity (entity_names + filter)", async () => {
		await owner.connections.update({
			connection_id: taggableConnectionId,
			entity_ids: [inOrgEntityId],
		});

		const result = (await owner.connections.list({
			entity_id: inOrgEntityId,
		})) as { connections?: Array<{ id: number; entity_names?: string }> };

		const match = result.connections?.find(
			(c) => Number(c.id) === taggableConnectionId,
		);
		expect(match).toBeDefined();
		expect(match?.entity_names ?? "").toContain("Direct Entity");
	});

	it("lists a connection under a feed-derived entity (union, no direct tag)", async () => {
		const result = (await owner.connections.list({
			entity_id: feedEntityId,
		})) as {
			connections?: Array<{
				id: number;
				entity_names?: string;
				entity_ids?: number[] | string | null;
			}>;
		};

		const match = result.connections?.find(
			(c) => Number(c.id) === feedLinkedConnectionId,
		);
		expect(match).toBeDefined();
		// The link is feed-derived: the connection itself has no entity_ids.
		expect(toIds(match?.entity_ids).length).toBe(0);
		expect(match?.entity_names ?? "").toContain("Feed Entity");
	});
});
