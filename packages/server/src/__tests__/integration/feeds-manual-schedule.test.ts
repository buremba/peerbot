/**
 * Collected feeds with no schedule are manual-only (no platform default cron).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { cleanupTestDatabase } from "../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";
import { TestApiClient } from "../setup/test-mcp-client";

describe("manage_feeds schedule (manual default)", () => {
	let owner: TestApiClient;
	let connectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Manual Schedule Org" });
		const user = await createTestUser({ email: "manual-sched@test.com" });
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		await createTestConnectorDefinition({
			key: "github",
			name: "GitHub",
			organization_id: org.id,
			feeds_schema: { issues: {}, pulls: {}, commits: {} },
		});
		const conn = await createTestConnection({
			organization_id: org.id,
			connector_key: "github",
			created_by: user.id,
			createDefaultFeed: false,
		});
		connectionId = Number(conn.id);
	});

	it("create_feed without schedule persists schedule/next_run_at NULL", async () => {
		const result = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "issues",
			display_name: "Issues manual",
		})) as {
			error?: string;
			feed?: {
				id: number;
				schedule: string | null;
				next_run_at: string | null;
			};
		};

		expect(result.error).toBeUndefined();
		expect(result.feed?.schedule).toBeNull();
		expect(result.feed?.next_run_at).toBeNull();
	});

	it("create_feed with an explicit cron still schedules", async () => {
		const result = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "pulls",
			display_name: "Pulls daily",
			schedule: "0 9 * * *",
		})) as {
			error?: string;
			feed?: {
				id: number;
				schedule: string | null;
				next_run_at: string | null;
			};
		};

		expect(result.error).toBeUndefined();
		expect(result.feed?.schedule).toBe("0 9 * * *");
		expect(result.feed?.next_run_at).toBeTruthy();
	});

	it("update_feed schedule null clears auto-poll", async () => {
		const created = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "commits",
			display_name: "Commits",
			schedule: "0 */12 * * *",
		})) as { error?: string; feed?: { id: number; schedule: string | null } };

		expect(created.error).toBeUndefined();
		const feedId = Number(created.feed?.id);
		expect(feedId).toBeGreaterThan(0);

		const updated = (await owner.feeds.update({
			feed_id: feedId,
			schedule: null,
		})) as {
			error?: string;
			feed?: { schedule: string | null; next_run_at: string | null };
		};

		expect(updated.error).toBeUndefined();
		expect(updated.feed?.schedule).toBeNull();
		expect(updated.feed?.next_run_at).toBeNull();
	});
});
