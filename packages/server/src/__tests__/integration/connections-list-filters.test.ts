import { beforeAll, describe, expect, it } from "vitest";
import { pgBigintArray } from "../../db/client";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { createTestConnection } from "../setup/test-fixtures";
import { TestWorkspace } from "../setup/test-mcp-client";

type Facets = {
	data: boolean;
	chat: boolean;
	actions: boolean;
	audience: boolean;
};

type ConnectionListResult = {
	connections?: Array<{
		id: number;
		display_name?: string | null;
		facets?: Facets;
		effective_credential_mode?: string | null;
	}>;
};

type ConnectorGroupsResult = {
	groups?: Array<{
		connector_key: string;
		connector_name: string | null;
		connection_count: number;
		facets?: Facets;
		connections: Array<{
			id: number;
			display_name: string | null;
			feed_count: number;
		}>;
	}>;
};

type FeedListResult = {
	feeds?: Array<{ id: number; connection_id: number }>;
};

function ids(rows: Array<{ id: number }> | undefined): number[] {
	return (rows ?? []).map((row) => Number(row.id)).sort((a, b) => a - b);
}

describe("manage_connections and manage_feeds list filters", () => {
	let workspace: TestWorkspace;
	let orgConnectionId: number;
	let memberPrivateConnectionId: number;
	let adminPrivateConnectionId: number;
	let slackChatConnectionId: number;
	let orgFeedId: number;
	let memberPrivateFeedId: number;

	beforeAll(async () => {
		await cleanupTestDatabase();
		workspace = await TestWorkspace.create({
			name: "Connection Filters Org",
			visibility: "public",
		});

		orgConnectionId = Number(
			(
				await createTestConnection({
					organization_id: workspace.org.id,
					connector_key: "github",
					display_name: "Org GitHub",
					created_by: workspace.users.owner.id,
					visibility: "org",
				})
			).id,
		);
		memberPrivateConnectionId = Number(
			(
				await createTestConnection({
					organization_id: workspace.org.id,
					connector_key: "github",
					display_name: "Member GitHub",
					created_by: workspace.users.member.id,
					visibility: "private",
				})
			).id,
		);
		adminPrivateConnectionId = Number(
			(
				await createTestConnection({
					organization_id: workspace.org.id,
					connector_key: "github",
					display_name: "Admin GitHub",
					created_by: workspace.users.admin.id,
					visibility: "private",
				})
			).id,
		);

		const sql = getTestDb();

		// A managed Slack chat connection: an ACL source (audience) + a live bot
		// adapter (chat). createTestConnection has no credential_mode param, so we
		// stamp the Stage-2a chat marker directly. createDefaultFeed gives it data.
		slackChatConnectionId = Number(
			(
				await createTestConnection({
					organization_id: workspace.org.id,
					connector_key: "slack",
					display_name: "Org Slack",
					created_by: workspace.users.owner.id,
					visibility: "org",
				})
			).id,
		);
		await sql`
			UPDATE connections SET credential_mode = 'managed'
			WHERE id = ${slackChatConnectionId}
		`;

		const feedRows = (await sql`
			SELECT id, connection_id
			FROM feeds
			WHERE connection_id = ANY(${pgBigintArray([
				orgConnectionId,
				memberPrivateConnectionId,
			])}::bigint[])
			ORDER BY id
		`) as unknown as Array<{ id: number; connection_id: number }>;
		orgFeedId = Number(
			feedRows.find((feed) => Number(feed.connection_id) === orgConnectionId)?.id,
		);
		memberPrivateFeedId = Number(
			feedRows.find(
				(feed) => Number(feed.connection_id) === memberPrivateConnectionId,
			)?.id,
		);
	});

	it("filters connections by explicit connection_ids", async () => {
		const result = (await workspace.owner.connections.list({
			connection_ids: [memberPrivateConnectionId, orgConnectionId],
		})) as ConnectionListResult;

		expect(ids(result.connections)).toEqual(
			[orgConnectionId, memberPrivateConnectionId].sort((a, b) => a - b),
		);
	});

	it("filters feeds by explicit feed_ids", async () => {
		const result = (await workspace.owner.feeds.list({
			feed_ids: [memberPrivateFeedId],
		})) as FeedListResult;

		expect(ids(result.feeds)).toEqual([memberPrivateFeedId]);
	});

	it("applies connection visibility to connector groups", async () => {
		const ownerGroups = (await workspace.owner.connections.manage({
			action: "list_connector_groups",
		})) as ConnectorGroupsResult;
		const ownerGithub = ownerGroups.groups?.find(
			(group) => group.connector_key === "github",
		);
		expect(ownerGithub?.connection_count).toBe(3);
		expect(ids(ownerGithub?.connections)).toEqual(
			[orgConnectionId, memberPrivateConnectionId, adminPrivateConnectionId].sort(
				(a, b) => a - b,
			),
		);
		expect(ownerGithub?.connections.find((c) => c.id === orgConnectionId)?.feed_count).toBe(1);

		const memberGroups = (await workspace.member.connections.manage({
			action: "list_connector_groups",
		})) as ConnectorGroupsResult;
		const memberGithub = memberGroups.groups?.find(
			(group) => group.connector_key === "github",
		);
		expect(memberGithub?.connection_count).toBe(2);
		expect(ids(memberGithub?.connections)).toEqual(
			[orgConnectionId, memberPrivateConnectionId].sort((a, b) => a - b),
		);

		const anonymousGroups = (await workspace.asAnonymous().connections.manage({
			action: "list_connector_groups",
		})) as ConnectorGroupsResult;
		const anonymousGithub = anonymousGroups.groups?.find(
			(group) => group.connector_key === "github",
		);
		expect(anonymousGithub?.connection_count).toBe(1);
		expect(ids(anonymousGithub?.connections)).toEqual([orgConnectionId]);
	});

	it("derives facets + credential mode on list (end-to-end SQL → helper)", async () => {
		const result = (await workspace.owner.connections.list({
			connection_ids: [orgConnectionId, slackChatConnectionId],
		})) as ConnectionListResult;

		const github = result.connections?.find((c) => c.id === orgConnectionId);
		// GitHub: ACL source (audience) + a live feed (data); not chat, and the
		// test catalog seeds no github operations (actions off).
		expect(github?.facets).toMatchObject({
			data: true,
			chat: false,
			audience: true,
		});

		const slack = result.connections?.find(
			(c) => c.id === slackChatConnectionId,
		);
		// Slack chat connection: credential_mode set (chat) + ACL source (audience).
		expect(slack?.facets).toMatchObject({ chat: true, audience: true });
		expect(slack?.effective_credential_mode).toBe("managed");
	});

	it("derives connector-group facets (union across the group)", async () => {
		const groups = (await workspace.owner.connections.manage({
			action: "list_connector_groups",
		})) as ConnectorGroupsResult;

		const githubGroup = groups.groups?.find(
			(g) => g.connector_key === "github",
		);
		expect(githubGroup?.facets).toMatchObject({ audience: true, chat: false });

		const slackGroup = groups.groups?.find((g) => g.connector_key === "slack");
		expect(slackGroup?.facets).toMatchObject({ chat: true, audience: true });
	});

	it("applies connection visibility to list and get", async () => {
		const memberList = (await workspace.member.connections.list({
			connection_ids: [adminPrivateConnectionId],
		})) as ConnectionListResult;
		expect(memberList.connections ?? []).toHaveLength(0);

		await expect(
			workspace.member.connections.get(adminPrivateConnectionId),
		).resolves.toMatchObject({ error: "Connection not found" });
		await expect(
			workspace.asAnonymous().connections.get(memberPrivateConnectionId),
		).resolves.toMatchObject({ error: "Connection not found" });
		await expect(
			workspace.member.connections.get(memberPrivateConnectionId),
		).resolves.toMatchObject({ action: "get" });
	});
});
