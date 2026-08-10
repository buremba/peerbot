/**
 * Behavior-mode `limit` must bound every SQL-backed source, not just the
 * primary event source.
 *
 * `queryContentData` builds its page descriptor with a hardcoded
 * `sourceName: 'content'`, and `wrapQuery` used to apply the LIMIT only when
 * `sourceName === page.sourceName`. Every other event source therefore ran
 * unbounded — and all of them are returned to the caller under `sources`. So a
 * Behavior with more than one source ignored `limit` entirely: the caller asked
 * for 2 rows and got the whole window back on the secondary source.
 *
 * That is what made Behavior 5 unreadable in prod. The sandbox counts every SDK
 * result as it crosses the isolate boundary, so an unbounded `sources` blob blew
 * the output cap before the script could filter anything — `limit: 1` and
 * `limit: 5` failed identically.
 *
 * The guards cover both failure classes: secondary event sources and
 * context-only SQL sources must be capped and report their truncation through
 * `sources_page`.
 */

import { beforeAll, describe, expect, it } from "vitest";
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

/** Rows seeded per feed. Must exceed PAGE_LIMIT so truncation is observable. */
const ROWS_PER_FEED = 3;
/** What the caller asks for. Below ROWS_PER_FEED on purpose. */
const PAGE_LIMIT = 2;

describe("behavior-mode limit bounds every SQL-backed source", () => {
	let owner: TestApiClient;
	let orgId: string;
	let agentId: string;
	let entityId: number;
	let primaryFeedId: number;
	let secondaryFeedId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Source Limit Org" });
		orgId = org.id;
		const user = await createTestUser({ email: "source-limit@test.com" });
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

		const entity = await createTestEntity({
			name: "Source Limit Target",
			entity_type: "company",
			organization_id: orgId,
			created_by: user.id,
		});
		entityId = Number(entity.id);

		// Two connections, each with its own `default` feed. They are referenced
		// by feed id rather than `@feed:default` — that ref matches on feed_key
		// and compiles to `feed_id IN (both)`, so each named source would read
		// both feeds identically and the per-source distinction would vanish.
		primaryFeedId = await seedFeed("primary-source-limit", "primary");
		secondaryFeedId = await seedFeed("secondary-source-limit", "secondary");
	});

	/** A connection + its default feed, carrying ROWS_PER_FEED events. */
	async function seedFeed(slug: string, label: string): Promise<number> {
		const sql = getTestDb();
		const connection = await createTestConnection({
			organization_id: orgId,
			connector_key: "test.connector",
			display_name: `Source Limit ${label}`,
			slug,
		});
		const [feed] = await sql<{ id: number | string }[]>`
      SELECT id FROM feeds WHERE connection_id = ${connection.id} AND feed_key = 'default'
    `;
		const feedId = Number(feed.id);
		for (let i = 0; i < ROWS_PER_FEED; i++) {
			await createTestEvent({
				entity_id: entityId,
				organization_id: orgId,
				connection_id: connection.id,
				feed_id: feedId,
				content: `${label} row ${i}`,
				// Distinct timestamps so keyset ordering is deterministic. Kept within
				// seconds of now so the `since: 'today'` window can't lose rows across
				// a midnight boundary.
				occurred_at: new Date(Date.now() - i * 1000),
			});
		}
		return feedId;
	}

	it("caps a secondary event source at the requested limit", async () => {
		const created = (await owner.behaviors.create({
			entity_id: entityId,
			slug: "multi-source-limit",
			name: "Multi Source Limit",
			prompt: "Summarize {{content}} alongside {{secondary}}.",
			agent_id: agentId,
			sources: [
				{ name: "content", query: `@feed:${primaryFeedId}` },
				{ name: "secondary", query: `@feed:${secondaryFeedId}` },
			],
		})) as { behavior_id: string };

		const result = (await owner.knowledge.read({
			behavior_id: created.behavior_id,
			since: "today",
			until: "today",
			limit: PAGE_LIMIT,
		})) as {
			sources: Record<string, unknown[]>;
			sources_page?: Record<
				string,
				{ returned: number; limit: number; has_more: boolean }
			>;
		};

		// The primary source was always bounded — assert it to prove the fixture
		// really did seed more rows than the limit, so the secondary assertion
		// below is measuring the bug and not an empty window.
		expect(result.sources.content).toHaveLength(PAGE_LIMIT);

		// THE regression. Before the fix this returned all ROWS_PER_FEED rows.
		expect(result.sources.secondary).toHaveLength(PAGE_LIMIT);

		// Truncation is reported, not silent — a caller can tell a fully-read
		// source from a capped one.
		expect(result.sources_page?.secondary).toEqual({
			returned: PAGE_LIMIT,
			limit: PAGE_LIMIT,
			has_more: true,
		});
		expect(result.sources_page?.content).toEqual({
			returned: PAGE_LIMIT,
			limit: PAGE_LIMIT,
			has_more: true,
		});
	});

	it("caps context:true SQL sources and reports truncation", async () => {
		const created = (await owner.behaviors.create({
			entity_id: entityId,
			slug: "context-source-limit",
			name: "Context Source Limit",
			prompt: "Summarize {{content}} with {{context_rows}}.",
			agent_id: agentId,
			sources: [
				{ name: "content", query: `@feed:${primaryFeedId}` },
				{
					name: "context_rows",
					query: "SELECT id, name, metadata FROM entities WHERE deleted_at IS NULL ORDER BY updated_at DESC",
					context: true,
				},
			],
		})) as { behavior_id: string };

		// Add enough context entities to exceed PAGE_LIMIT. These ids are entity
		// ids, not event ids — the exact reason context:true bypasses event paging.
		for (let i = 0; i < ROWS_PER_FEED; i++) {
			await createTestEntity({
				name: `Context Entity ${i}`,
				entity_type: "company",
				organization_id: orgId,
			});
		}

		const result = (await owner.knowledge.read({
			behavior_id: created.behavior_id,
			since: "today",
			until: "today",
			limit: PAGE_LIMIT,
		})) as {
			sources: Record<string, unknown[]>;
			sources_page?: Record<string, { returned: number; limit: number; has_more: boolean }>;
		};

		expect(result.sources.context_rows).toHaveLength(PAGE_LIMIT);
		expect(result.sources_page?.context_rows).toEqual({
			returned: PAGE_LIMIT,
			limit: PAGE_LIMIT,
			has_more: true,
		});
	});

	it("reports has_more false when a source fits inside the limit", async () => {
		const created = (await owner.behaviors.create({
			entity_id: entityId,
			slug: "multi-source-fits",
			name: "Multi Source Fits",
			prompt: "Summarize {{content}} alongside {{secondary}}.",
			agent_id: agentId,
			sources: [
				{ name: "content", query: `@feed:${primaryFeedId}` },
				{ name: "secondary", query: `@feed:${secondaryFeedId}` },
			],
		})) as { behavior_id: string };

		const roomy = ROWS_PER_FEED + 1;
		const result = (await owner.knowledge.read({
			behavior_id: created.behavior_id,
			since: "today",
			until: "today",
			limit: roomy,
		})) as {
			sources: Record<string, unknown[]>;
			sources_page?: Record<
				string,
				{ returned: number; limit: number; has_more: boolean }
			>;
		};

		expect(result.sources.secondary).toHaveLength(ROWS_PER_FEED);
		expect(result.sources_page?.secondary).toEqual({
			returned: ROWS_PER_FEED,
			limit: roomy,
			has_more: false,
		});
	});
});
