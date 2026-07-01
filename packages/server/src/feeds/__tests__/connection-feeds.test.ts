import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupTestDatabase, getTestDb } from "../../__tests__/setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../__tests__/setup/test-fixtures";
import { listConnectionFeeds } from "../connection-feeds";

async function seedConnection(opts: {
	orgId: string;
	userId: string;
	slug: string;
	deletedAt?: Date | null;
}): Promise<number> {
	const sql = getTestDb();
	const [row] = await sql`
		INSERT INTO connections (
			organization_id, connector_key, slug, display_name, status,
			created_by, visibility, created_at, updated_at, deleted_at
		) VALUES (
			${opts.orgId}, 'slack', ${opts.slug}, ${`Conn ${opts.slug}`}, 'active',
			${opts.userId}, 'org', NOW(), NOW(), ${opts.deletedAt ?? null}
		)
		RETURNING id
	`;
	return Number(row.id);
}

async function seedFeed(opts: {
	orgId: string;
	connectionId: number;
	feedKey: string;
	kind: "collected" | "streaming" | "virtual";
	displayName?: string | null;
	itemsCollected?: number;
	deletedAt?: Date | null;
}): Promise<void> {
	const sql = getTestDb();
	await sql`
		INSERT INTO feeds (
			organization_id, connection_id, feed_key, kind, display_name,
			status, items_collected, last_sync_at, deleted_at, created_at, updated_at
		) VALUES (
			${opts.orgId}, ${opts.connectionId}, ${opts.feedKey}, ${opts.kind},
			${opts.displayName ?? null}, 'active', ${opts.itemsCollected ?? 0},
			NOW(), ${opts.deletedAt ?? null}, NOW(), NOW()
		)
	`;
}

describe("listConnectionFeeds", () => {
	let orgId: string;
	let agentId: string;
	let connectionId: number;
	// A managed-install slug: the runtime id is non-numeric and equals the slug.
	// This is the case the route hits — casting it to bigint (the old bug) throws.
	const runtimeConnId = "slackinst-feedsconn";

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Feeds Org" });
		orgId = org.id;
		const user = await createTestUser({ email: "feeds-owner@test.com" });
		// NOTE: the fixture returns `agentId` (not `id`) — the original #1658 test
		// used `agent.id` (undefined), which threw UNDEFINED_VALUE when bound.
		const agent = await createTestAgent({ organizationId: orgId });
		agentId = agent.agentId;
		connectionId = await seedConnection({
			orgId,
			userId: user.id,
			slug: runtimeConnId,
		});

		await seedFeed({
			orgId,
			connectionId,
			feedKey: "slack:C123",
			kind: "streaming",
			itemsCollected: 5,
		});
		await seedFeed({
			orgId,
			connectionId,
			feedKey: "inbox",
			kind: "collected",
			displayName: "Inbox",
		});
		// A soft-deleted feed must be excluded.
		await seedFeed({
			orgId,
			connectionId,
			feedKey: "gone",
			kind: "collected",
			deletedAt: new Date(),
		});

		// Bind the streaming channel to the agent so `target_agent_id` populates.
		const sql = getTestDb();
		await sql`
			INSERT INTO agent_channel_bindings
				(agent_id, platform, channel_id, team_id, organization_id, connection_id, created_at)
			VALUES
				(${agentId}, 'slack', 'slack:C123', 'T1', ${orgId}, ${connectionId}, NOW())
		`;
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	it("resolves a non-numeric runtime id via slug, excludes soft-deleted, and decorates the streaming feed with its bound agent", async () => {
		const feeds = await listConnectionFeeds(orgId, runtimeConnId);

		expect(feeds).toHaveLength(2);
		const byKind = Object.fromEntries(feeds.map((f) => [f.kind, f]));

		expect(byKind.streaming?.feedKey).toBe("slack:C123");
		expect(byKind.streaming?.label).toBe("slack:C123"); // falls back to feed_key
		expect(byKind.streaming?.itemsCollected).toBe(5);
		expect(byKind.streaming?.targetAgentId).toBe(agentId);
		expect(byKind.streaming?.lastSyncAt).not.toBeNull();

		expect(byKind.collected?.feedKey).toBe("inbox");
		expect(byKind.collected?.label).toBe("Inbox");
		expect(byKind.collected?.targetAgentId ?? null).toBeNull();
	});

	it("returns nothing for a connection in a different org scope", async () => {
		const feeds = await listConnectionFeeds("org-does-not-exist", runtimeConnId);
		expect(feeds).toHaveLength(0);
	});

	it("resolves the live connection when a soft-deleted row shares its slug", async () => {
		// A soft-deleted connection keeps its slug (the unique index only covers
		// live rows), so the slug resolver could match both and error. It must
		// still resolve the single live row's feeds.
		const user = await createTestUser({ email: "feeds-dup@test.com" });
		await seedConnection({
			orgId,
			userId: user.id,
			slug: runtimeConnId,
			deletedAt: new Date(),
		});

		const feeds = await listConnectionFeeds(orgId, runtimeConnId);
		expect(feeds).toHaveLength(2);
	});
});
