/**
 * manage_feeds delete_feed — cross-org isolation.
 *
 * Regression: `handleDeleteFeed` cancelled active runs by `feed_id` BEFORE
 * proving the feed belonged to the caller's org (the run-cancel UPDATE is not
 * org-scoped — runs reach their org only through the feed). A guessed foreign
 * feed_id could therefore cancel ANOTHER org's runs even though the org-scoped
 * feed delete then no-ops. The fix deletes the org-owned feed first and bails
 * on no match, so no cross-org side effect happens before the ownership check.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ClientSdkActionError } from "../../sandbox/namespaces/action-call";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
	createTestConnection,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";
import { TestApiClient } from "../setup/test-mcp-client";

describe("manage_feeds delete_feed cross-org isolation", () => {
	let attacker: TestApiClient;
	let victimOrgId: string;
	let victimFeedId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		const sql = getTestDb();

		// Victim org: a connection (which seeds a feed) + an active run on it.
		const victimOrg = await createTestOrganization({ name: "Victim Org" });
		victimOrgId = victimOrg.id;
		const victimUser = await createTestUser({ email: "victim@test.com" });
		const conn = await createTestConnection({
			organization_id: victimOrgId,
			connector_key: "github",
			created_by: victimUser.id,
		});
		const [feed] = await sql<{ id: number }[]>`
      SELECT id FROM feeds WHERE connection_id = ${conn.id} AND organization_id = ${victimOrgId}
      LIMIT 1
    `;
		victimFeedId = Number(feed?.id);
		await sql`
      INSERT INTO runs (
        organization_id, run_type, feed_id, connection_id,
        connector_key, status, approval_status, created_at
      ) VALUES (
        ${victimOrgId}, 'sync', ${victimFeedId}, ${conn.id},
        'github', 'running', 'auto', NOW()
      )
    `;

		// Attacker org: a separate org whose owner will guess the victim's feed_id.
		const attackerOrg = await createTestOrganization({ name: "Attacker Org" });
		const attackerUser = await createTestUser({ email: "attacker@test.com" });
		attacker = await TestApiClient.for({
			organizationId: attackerOrg.id,
			userId: attackerUser.id,
			memberRole: "owner",
		});
	});

	it("does not cancel another org's runs and reports the feed as not found", async () => {
		const error = await attacker.feeds
			.delete({ feed_id: victimFeedId })
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(ClientSdkActionError);
		expect((error as ClientSdkActionError).result.error).toBe(
			"Feed not found or already deleted",
		);

		const sql = getTestDb();
		// The victim's run is untouched (NOT cancelled) — ownership was checked
		// before any run-cancel side effect.
		const [run] = await sql<{ status: string }[]>`
      SELECT status FROM runs
      WHERE feed_id = ${victimFeedId} AND organization_id = ${victimOrgId}
      LIMIT 1
    `;
		expect(run?.status).toBe("running");

		// The victim's feed is still live (not soft-deleted by the foreign call).
		const [feed] = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM feeds WHERE id = ${victimFeedId}
    `;
		expect(feed?.deleted_at).toBeNull();
	});

	it("the legitimate owner can delete the feed and that cancels its active runs", async () => {
		const owner = await TestApiClient.for({
			organizationId: victimOrgId,
			userId: (await createTestUser({ email: "victim-owner@test.com" })).id,
			memberRole: "owner",
		});
		const result = (await owner.feeds.delete({ feed_id: victimFeedId })) as {
			deleted?: boolean;
		};
		expect(result.deleted).toBe(true);

		const sql = getTestDb();
		const [run] = await sql<{ status: string }[]>`
      SELECT status FROM runs
      WHERE feed_id = ${victimFeedId} AND organization_id = ${victimOrgId}
      LIMIT 1
    `;
		expect(run?.status).toBe("cancelled");
	});
});
