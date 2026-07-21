/**
 * list_feeds must report the true match count and expose active-but-failing
 * feeds.
 *
 * Two gaps this covers:
 *  - `total` was `rows.length` (the page length), so a 3-feed page reported
 *    total:3 even when more matched — and `total === limit` was
 *    indistinguishable from an exact count. It is now COUNT(*) OVER() across
 *    the whole filtered set, plus a `has_more` flag.
 *  - A feed keeps `status = 'active'` while its syncs fail (until it crosses
 *    the auto-pause threshold), so the `status` filter can never surface a
 *    failing-but-active feed. The new `health` filter matches on
 *    last_sync_status/consecutive_failures.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../index";
import { manageFeeds } from "../../tools/admin/manage_feeds";
import type { ToolContext } from "../../tools/registry";
import { initWorkspaceProvider } from "../../workspace";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestConnection, seedOwnerContext } from "../setup/test-fixtures";

describe("list_feeds health filter and true total", () => {
	let orgId: string;
	let ctx: ToolContext;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org, ctx: ownerCtx } = await seedOwnerContext({
			orgName: "Feeds Health Org",
		});
		orgId = org.id;
		ctx = ownerCtx;

		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "hackernews",
			createDefaultFeed: false,
		});
		connectionId = conn.id;

		const sql = getTestDb();
		// 5 feeds: 3 healthy active, 1 active-but-failing (last sync failed),
		// 1 active with consecutive failures but last sync not yet marked failed.
		const feeds: Array<{
			key: string;
			status: string;
			last: string | null;
			fails: number;
		}> = [
			{ key: "h1", status: "active", last: "success", fails: 0 },
			{ key: "h2", status: "active", last: "success", fails: 0 },
			{ key: "h3", status: "active", last: null, fails: 0 },
			{ key: "bad1", status: "active", last: "failed", fails: 14 },
			{ key: "bad2", status: "active", last: "success", fails: 3 },
		];
		for (const f of feeds) {
			await sql`
				INSERT INTO feeds (
					organization_id, connection_id, feed_key, status,
					last_sync_status, consecutive_failures, entity_ids, created_at, updated_at
				) VALUES (
					${orgId}, ${connectionId}, ${f.key}, ${f.status},
					${f.last}, ${f.fails}, ARRAY[]::bigint[], NOW(), NOW()
				)
			`;
		}
	});

	async function list(args: Record<string, unknown>): Promise<{
		feeds: Array<Record<string, unknown>>;
		total: number;
		has_more: boolean;
	}> {
		return (await manageFeeds(
			{ action: "list_feeds", connection_id: connectionId, ...args },
			{} as Env,
			ctx,
		)) as {
			feeds: Array<Record<string, unknown>>;
			total: number;
			has_more: boolean;
		};
	}

	it("reports the true total across pages, not the page length, with has_more", async () => {
		const page1 = await list({ limit: 2, offset: 0 });
		expect(page1.feeds).toHaveLength(2);
		expect(page1.total).toBe(5);
		expect(page1.has_more).toBe(true);

		const lastPage = await list({ limit: 2, offset: 4 });
		expect(lastPage.feeds).toHaveLength(1);
		expect(lastPage.total).toBe(5);
		expect(lastPage.has_more).toBe(false);
	});

	it("does not leak the internal count column onto feed rows", async () => {
		const res = await list({ limit: 10 });
		for (const feed of res.feeds) {
			expect(feed).not.toHaveProperty("filtered_total");
		}
	});

	it("health=failing surfaces active-but-failing feeds status cannot", async () => {
		// status filter sees them all as active
		const active = await list({ status: "active" });
		expect(active.total).toBe(5);

		const failing = await list({ health: "failing" });
		const keys = failing.feeds.map((f) => f.feed_key).sort();
		expect(keys).toEqual(["bad1", "bad2"]);
		expect(failing.total).toBe(2);
	});

	it("health=healthy excludes failing feeds", async () => {
		const healthy = await list({ health: "healthy" });
		const keys = healthy.feeds.map((f) => f.feed_key).sort();
		expect(keys).toEqual(["h1", "h2", "h3"]);
		expect(healthy.total).toBe(3);
	});

	it("returns has_more:false and total:0 for an empty filtered set", async () => {
		const none = await list({ health: "failing", feed_ids: [999999999] });
		expect(none.feeds).toHaveLength(0);
		expect(none.total).toBe(0);
		expect(none.has_more).toBe(false);
	});

	it("rejects update_feed status:'error' — a runtime state, not a settable one", async () => {
		// 'error' is in the DB CHECK but nothing writes it; a failing feed stays
		// active and is found via health:failing. Letting an agent set it would
		// create a zombie state the list status filter cannot select.
		const [row] = (await getTestDb()`
			SELECT id FROM feeds WHERE organization_id = ${orgId} AND feed_key = 'h1'
		`) as unknown as Array<{ id: number }>;
		await expect(
			manageFeeds(
				{ action: "update_feed", feed_id: Number(row.id), status: "error" },
				{} as Env,
				ctx,
			),
		).rejects.toThrow();
	});
});
