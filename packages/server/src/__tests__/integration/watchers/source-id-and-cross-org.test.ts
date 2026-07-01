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
import type { Env } from "../../../index";
import { verifyWindowToken } from "../../../utils/jwt";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestConnection,
	createTestEntity,
	createTestEvent,
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

	it("resolves source refs and only signs event-backed content ids", async () => {
		const sql = getTestDb();
		const connection = await createTestConnection({
			organization_id: ownerOrgId,
			connector_key: "test.connector",
			display_name: "Watcher Source Ref Connection",
			slug: "watcher-source-ref-connection",
		});
		const [feed] = await sql<{ id: number | string }[]>`
      SELECT id FROM feeds WHERE connection_id = ${connection.id} AND feed_key = 'default'
    `;
		const event = await createTestEvent({
			entity_id: inOrgEntityId,
			organization_id: ownerOrgId,
			connection_id: connection.id,
			feed_id: Number(feed.id),
			content: "Feedback from the default feed.",
			occurred_at: new Date(),
		});
		const customer = await createTestEntity({
			name: "Source Ref Customer",
			entity_type: "customer",
			organization_id: ownerOrgId,
		});

		const created = (await owner.watchers.create({
			entity_id: inOrgEntityId,
			slug: "source-ref-context",
			name: "Source Ref Context",
			prompt: "Track {{content}} with customer context.",
			agent_id: agentId,
			sources: [
				{ name: "content", query: "@feed:default" },
				{ name: "customers", query: "@entity:customer" },
			],
		})) as { watcher_id: string };

		const result = (await owner.knowledge.read({
			watcher_id: created.watcher_id,
			since: "today",
			until: "today",
		})) as {
			content: Array<{ id: number }>;
			total: number;
			window_token: string;
			sources: Record<string, Array<{ id: number | string }>>;
		};

		expect(result.total).toBe(1);
		expect(result.content.map((row) => Number(row.id))).toEqual([event.id]);
		expect(result.sources.content.map((row) => Number(row.id))).toContain(event.id);
		expect(result.sources.customers.map((row) => Number(row.id))).toContain(customer.id);

		const token = await verifyWindowToken(result.window_token, {
			JWT_SECRET: "test-jwt-secret-for-testing-only",
		} as Env);
		expect(token.content_ids).toEqual([event.id]);
		expect(token.content_ids).not.toContain(customer.id);

		const orgScoped = (await owner.watchers.create({
			slug: "source-ref-org-count",
			name: "Source Ref Org Count",
			prompt: "Track {{content}}.",
			agent_id: agentId,
			sources: [{ name: "content", query: "@feed:default" }],
		})) as { watcher_id: string };

		const orgResult = (await owner.knowledge.read({
			watcher_id: orgScoped.watcher_id,
			since: "today",
			until: "today",
		})) as {
			total: number;
			total_count?: number;
			total_count_chars?: number;
		};

		// Regression guard: the old stats query counted only watcher.entity_ids, so
		// an org-scoped @feed watcher returned content but reported total_count=0.
		expect(orgResult.total).toBe(1);
		expect(orgResult.total_count).toBe(1);
		expect(Number(orgResult.total_count_chars)).toBeGreaterThan(0);
	});

	it("rejects create_version when a source query omits id", async () => {
		const created = (await owner.watchers.create({
			entity_id: inOrgEntityId,
			slug: "version-id-guard",
			name: "Version Id Guard",
			prompt: "Track stuff.",
			agent_id: agentId,
			sources: [{ name: "content", query: "SELECT id FROM events" }],
		})) as { watcher_id: string };

		await expect(
			owner.watchers.createVersion({
				watcher_id: created.watcher_id,
				prompt: "Track stuff v2.",
				change_notes: "omit id",
				sources: [
					{ name: "content", query: "SELECT payload_text FROM events" },
				],
			} as never),
		).rejects.toThrow(/id/i);
	});

	// ---- Save-time ref resolution (gap #1) ----

	it("rejects create when an @feed ref matches no feed", async () => {
		await expect(
			owner.watchers.create({
				entity_id: inOrgEntityId,
				slug: "typo-feed",
				name: "Typo Feed",
				prompt: "Track stuff.",
				agent_id: agentId,
				sources: [
					{ name: "content", query: "@feed:nonexistent-typo" },
				],
			}),
		).rejects.toThrow(/nonexistent-typo/i);
	});

	it("rejects create when an @feed ref points at a streaming (channel) feed", async () => {
		// A streaming/channel feed's rows live in channel_messages, not events, so
		// an @feed source over it would validate then read empty. Reject it loudly.
		const sql = getTestDb();
		const connection = await createTestConnection({
			organization_id: ownerOrgId,
			connector_key: "slack",
			display_name: "Streaming Feed Connection",
			slug: "streaming-feed-connection",
		});
		await sql`
			INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status, kind, virtual, config)
			VALUES (${ownerOrgId}, ${connection.id}, 'slack:C123', 'general', 'active', 'streaming', false, ${sql.json({ store: "channel_messages" })}::jsonb)
		`;

		await expect(
			owner.watchers.create({
				entity_id: inOrgEntityId,
				slug: "streaming-feed-src",
				name: "Streaming Feed Src",
				prompt: "Track stuff.",
				agent_id: agentId,
				sources: [{ name: "content", query: "@feed:slack:C123" }],
			}),
		).rejects.toThrow(/streaming feed|collected/i);
	});

	it("rejects create when an @entity ref is not a type in the org", async () => {
		await expect(
			owner.watchers.create({
				entity_id: inOrgEntityId,
				slug: "typo-entity",
				name: "Typo Entity",
				prompt: "Track stuff.",
				agent_id: agentId,
				sources: [
					{ name: "ctx", query: "@entity:nope-not-a-type" },
				],
			}),
		).rejects.toThrow(/entity type/i);
	});

	it("rejects create when an @metric ref points at an undeclared measure", async () => {
		await expect(
			owner.watchers.create({
				entity_id: inOrgEntityId,
				slug: "typo-metric",
				name: "Typo Metric",
				prompt: "Track stuff.",
				agent_id: agentId,
				sources: [
					{
						name: "m",
						query: "@metric:company.totally-fake-measure",
					},
				],
			}),
		).rejects.toThrow(/measure/i);
	});

	// ---- BUG B ----

	it("create_from_version rejects a cross-org entity_id", async () => {
		const base = (await owner.watchers.create({
			entity_id: inOrgEntityId,
			slug: "cfv-base",
			name: "CFV Base",
			prompt: "Track stuff.",
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
