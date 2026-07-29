/**
 * manage_feeds create_feed — VIRTUAL feed creation (PR #1702).
 *
 * A virtual feed is read LIVE and never synced, so create_feed must:
 *  - allow optional config.query (empty = unbounded for connectors that support it);
 *  - persist kind='virtual', virtual=true, and schedule/next_run_at = NULL;
 *  - NOT validate the (irrelevant) sync schedule — a bad/absent schedule string
 *    must not gate a virtual feed's creation. This is the ordering fix: schedule
 *    validation used to run before the isVirtual branch, wrongly rejecting
 *    create_feed({ virtual:true, schedule:'not-a-cron' }).
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { ClientSdkActionError } from "../../../sandbox/namespaces/action-call";
import { materializeDueFeeds } from "../../../scheduled/check-due-feeds";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	createTestConnection,
	createTestConnectorDefinition,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { TestApiClient } from "../../setup/test-mcp-client";

describe("manage_feeds create_feed (virtual)", () => {
	let owner: TestApiClient;
	let orgId: string;
	let connectionId: number;
	let jiraConnectionId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Virtual Create Org" });
		orgId = org.id;
		const user = await createTestUser({ email: "vcreate@test.com" });
		owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		const conn = await createTestConnection({
			organization_id: orgId,
			connector_key: "github",
			created_by: user.id,
			createDefaultFeed: false,
		});
		connectionId = Number(conn.id);

		// Jira-shaped definition: issues feed declares virtual:true so create_feed
		// without an explicit virtual flag still creates a live feed (schema default).
		await createTestConnectorDefinition({
			key: "jira",
			name: "Jira",
			organization_id: orgId,
			feeds_schema: {
				issues: {
					key: "issues",
					name: "Issues",
					virtual: true,
					configSchema: { type: "object", properties: {} },
				},
			},
		});
		const jiraConn = await createTestConnection({
			organization_id: orgId,
			connector_key: "jira",
			created_by: user.id,
			createDefaultFeed: false,
		});
		jiraConnectionId = Number(jiraConn.id);
	});

	it("creates a virtual feed with schedule/next_run_at NULL and kind=virtual", async () => {
		const result = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "issues",
			virtual: true,
			config: { query: "is:issue is:open" },
		})) as {
			error?: string;
			feed?: {
				id: number;
				kind: string;
				virtual: boolean;
				schedule: string | null;
				next_run_at: string | null;
			};
		};

		expect(result.error).toBeUndefined();
		expect(result.feed?.kind).toBe("virtual");
		expect(result.feed?.virtual).toBe(true);
		expect(result.feed?.schedule).toBeNull();
		expect(result.feed?.next_run_at).toBeNull();
	});

	it("allows a virtual feed with no config.query (unbounded live read)", async () => {
		const result = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "issues",
			virtual: true,
			config: { recall: true },
		})) as {
			error?: string;
			feed?: { kind: string; virtual: boolean; config?: { recall?: boolean } };
		};

		expect(result.error).toBeUndefined();
		expect(result.feed?.kind).toBe("virtual");
		expect(result.feed?.virtual).toBe(true);
		expect(result.feed?.config?.recall).toBe(true);
	});

	it("does NOT validate the sync schedule for a virtual feed (ordering fix)", async () => {
		// A malformed schedule string that validateSchedule would reject — it must be
		// ignored because a virtual feed persists schedule = NULL.
		const result = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "issues",
			virtual: true,
			schedule: "not-a-cron-expression",
			config: { query: "is:issue" },
		})) as { error?: string; feed?: { schedule: string | null } };

		expect(result.error).toBeUndefined();
		expect(result.feed?.schedule).toBeNull();
	});

	it("still validates the schedule for a NON-virtual feed", async () => {
		const error = await owner.feeds
			.create({
				connection_id: connectionId,
				feed_key: "issues",
				schedule: "not-a-cron-expression",
			})
			.catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(ClientSdkActionError);
	});

	it("defaults virtual from feeds_schema when the caller omits virtual (Jira issues)", async () => {
		const result = (await owner.feeds.create({
			connection_id: jiraConnectionId,
			feed_key: "issues",
			config: { query: "project = SUPP ORDER BY updated DESC" },
		})) as {
			error?: string;
			feed?: {
				kind: string;
				virtual: boolean;
				schedule: string | null;
			};
		};

		expect(result.error).toBeUndefined();
		expect(result.feed?.kind).toBe("virtual");
		expect(result.feed?.virtual).toBe(true);
		expect(result.feed?.schedule).toBeNull();
	});

	it("allows explicit virtual:false to override a schema-default-virtual feed", async () => {
		const result = (await owner.feeds.create({
			connection_id: jiraConnectionId,
			feed_key: "issues",
			virtual: false,
			schedule: "0 * * * *",
			config: { jql: "project = SUPP" },
		})) as {
			error?: string;
			feed?: { kind: string; virtual: boolean; schedule: string | null };
		};

		expect(result.error).toBeUndefined();
		expect(result.feed?.kind).toBe("collected");
		expect(result.feed?.virtual).toBe(false);
		expect(result.feed?.schedule).toBe("0 * * * *");
	});

	it("materializeDueFeeds never creates a sync run for the virtual feed", async () => {
		const created = (await owner.feeds.create({
			connection_id: connectionId,
			feed_key: "issues",
			virtual: true,
			config: { query: "is:issue is:open" },
		})) as { feed?: { id: number } };
		const feedId = Number(created.feed?.id);

		// Force the virtual feed "due" (past next_run_at) so the `virtual` guard —
		// not a NULL schedule — is what excludes it, then run the scheduler.
		const sql = getTestDb();
		await sql`UPDATE feeds SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = ${feedId}`;
		await materializeDueFeeds({} as Env, sql);

		const [runs] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM runs WHERE feed_id = ${feedId} AND run_type = 'sync'
    `;
		expect(Number(runs?.n)).toBe(0);
	});
});
