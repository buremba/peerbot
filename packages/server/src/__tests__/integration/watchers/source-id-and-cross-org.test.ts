/**
 * manage_watchers correctness guards:
 *
 *  BUG A — a source query that omits `id` is rejected at create/create_version
 *  time. Watcher-mode aggregation keys rows by `id` and the signed window_token
 *  only carries those ids, so an id-less source produces content_linked: 0 at
 *  complete_window and SILENTLY skips the reaction. We reject it on save.
 *
 *  BUG B — create_from_version rejects entity_ids that belong to another org.
 *  A watcher attached to a foreign entity links its content to a non-existent
 *  in-org entity.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { TestApiClient } from "../../setup/test-mcp-client";

describe("manage_watchers source-id + cross-org guards", () => {
	let owner: TestApiClient;
	let ownerOrgId: string;
	let agentId: string;
	let inOrgEntityId: number;
	let foreignEntityId: number;

	const schema = {
		type: "object",
		properties: { items: { type: "array", items: { type: "string" } } },
	};

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Watcher Guard Org" });
		ownerOrgId = org.id;
		const user = await createTestUser({ email: "watcher-guard@test.com" });
		await addUserToOrganization(user.id, org.id, "owner");
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		const agent = await createTestAgent({
			organizationId: org.id,
			ownerUserId: user.id,
		});
		agentId = agent.agentId;

		const inOrg = await createTestEntity({
			name: "In-Org Watcher Target",
			entity_type: "company",
			organization_id: ownerOrgId,
			created_by: user.id,
		});
		inOrgEntityId = Number(inOrg.id);

		const foreignOrg = await createTestOrganization({
			name: "Watcher Foreign Org",
		});
		const foreignEntity = await createTestEntity({
			name: "Foreign Watcher Target",
			entity_type: "company",
			organization_id: foreignOrg.id,
		});
		foreignEntityId = Number(foreignEntity.id);
	});

	// ---- BUG A ----

	it("rejects create when a source query omits the id column", async () => {
		await expect(
			owner.watchers.create({
				entity_id: inOrgEntityId,
				slug: "no-id-source",
				name: "No Id Source",
				prompt: "Track stuff.",
				extraction_schema: schema,
				agent_id: agentId,
				sources: [
					{
						name: "content",
						query: "SELECT origin_id, payload_text FROM events",
					},
				],
			}),
		).rejects.toThrow(/id/i);
	});

	it("accepts create when the source query projects id", async () => {
		const created = (await owner.watchers.create({
			entity_id: inOrgEntityId,
			slug: "with-id-source",
			name: "With Id Source",
			prompt: "Track stuff.",
			extraction_schema: schema,
			agent_id: agentId,
			sources: [
				{
					name: "content",
					query: "SELECT id, origin_id, payload_text FROM events",
				},
			],
		})) as { watcher_id?: string };
		expect(created.watcher_id).toBeDefined();
	});

	it("rejects create_version when a source query omits id", async () => {
		const created = (await owner.watchers.create({
			entity_id: inOrgEntityId,
			slug: "version-id-guard",
			name: "Version Id Guard",
			prompt: "Track stuff.",
			extraction_schema: schema,
			agent_id: agentId,
			sources: [{ name: "content", query: "SELECT id FROM events" }],
		})) as { watcher_id: string };

		await expect(
			owner.watchers.createVersion({
				watcher_id: created.watcher_id,
				prompt: "Track stuff v2.",
				extraction_schema: schema,
				change_notes: "omit id",
				sources: [
					{ name: "content", query: "SELECT payload_text FROM events" },
				],
			} as never),
		).rejects.toThrow(/id/i);
	});

	// ---- BUG B ----

	it("create_from_version rejects a cross-org entity_id", async () => {
		const base = (await owner.watchers.create({
			entity_id: inOrgEntityId,
			slug: "cfv-base",
			name: "CFV Base",
			prompt: "Track stuff.",
			extraction_schema: schema,
			agent_id: agentId,
			sources: [{ name: "content", query: "SELECT id FROM events" }],
		})) as { watcher_id: string };

		const sql = getTestDb();
		const [row] = await sql<{ current_version_id: number }[]>`
      SELECT current_version_id FROM watchers WHERE id = ${base.watcher_id}
    `;
		const versionId = Number(row?.current_version_id);
		expect(versionId).toBeGreaterThan(0);

		await expect(
			owner.watchers.createFromVersion({
				version_id: versionId,
				entity_ids: [foreignEntityId],
			}),
		).rejects.toThrow(new RegExp(String(foreignEntityId)));

		// No watcher leaked pointing at the foreign entity.
		const leaked = await sql<{ id: number }[]>`
      SELECT id FROM watchers
      WHERE organization_id = ${ownerOrgId} AND ${foreignEntityId} = ANY(entity_ids)
    `;
		expect(leaked.length).toBe(0);
	});

	it("create_from_version accepts an in-org entity_id", async () => {
		const base = (await owner.watchers.create({
			entity_id: inOrgEntityId,
			slug: "cfv-base-ok",
			name: "CFV Base OK",
			prompt: "Track stuff.",
			extraction_schema: schema,
			agent_id: agentId,
			sources: [{ name: "content", query: "SELECT id FROM events" }],
		})) as { watcher_id: string };

		const sql = getTestDb();
		const [row] = await sql<{ current_version_id: number }[]>`
      SELECT current_version_id FROM watchers WHERE id = ${base.watcher_id}
    `;
		const versionId = Number(row?.current_version_id);

		const result = (await owner.watchers.createFromVersion({
			version_id: versionId,
			entity_ids: [inOrgEntityId],
		})) as { created: Array<{ watcher_id: string }> };
		expect(result.created.length).toBe(1);
	});
});
