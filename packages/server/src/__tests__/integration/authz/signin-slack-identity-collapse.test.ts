/**
 * Sign-in collapse — END TO END through the ACL channel graph.
 *
 * Proves the production effect of stamping `slack_user_id` on Slack sign-in:
 * the workspace member COLLAPSES onto the user's existing `$member` entity
 * instead of forking a new `person`. Before the fix, sign-in wrote only
 * `auth_user_id` + `email`, so the channel-graph builder — which resolves
 * members on the canonical `slack_user_id` namespace — never matched the
 * `$member` and minted a separate `person` for the same human.
 *
 * Flow: provision a `$member` with ONLY `auth_user_id` (the pre-fix state) →
 * run `persistLoginSlackIdentity` (network reads stubbed, real DB write) →
 * build the channel graph with that user as a channel member → assert the
 * member edge lands on the EXISTING `$member`, and no new `person` was created.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	persistLoginSlackIdentity,
	provisionMemberAndCoreIdentities,
} from "../../../auth/subject-identities";
import { buildSlackChannelGraph } from "../../../authz/slack-channel-graph";
import { resolveTenantMember } from "../../../identity/auth-hook";
import { clearEntityLinkRulesCache } from "../../../utils/entity-link-upsert";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
	insertChatConnectionRow,
} from "../../setup/test-fixtures";

const TEAM = "T01ACME";
const CONN = "conn-acme";
const SLACK_USER = "U01ALICE";

/** persistLoginSlackIdentity deps: real tenant resolution, stubbed network. */
function slackDeps(teamId: string | undefined) {
	return {
		resolveTenantMember,
		getEnabledLoginProviderConfigs: async () => [
			{
				connectorKey: "slack",
				provider: "slack",
				loginScopes: [],
				clientIdKey: "SLACK_CLIENT_ID",
				clientSecretKey: "SLACK_CLIENT_SECRET",
				userinfoUrl: "https://slack.test/userInfo",
			},
		],
		fetchUserInfoWithRaw: async () => ({
			raw: teamId
				? {
						"https://slack.com/team_id": teamId,
						"https://slack.com/user_id": SLACK_USER,
					}
				: { "https://slack.com/user_id": SLACK_USER },
			normalized: null,
		}),
	};
}

describe("sign-in slack_user_id collapse (e2e via channel graph)", () => {
	beforeAll(async () => {
		await initWorkspaceProvider();
	});
	beforeEach(async () => {
		await cleanupTestDatabase();
		clearEntityLinkRulesCache();
	});

	it("collapses the workspace member onto the existing $member, never forking a person", async () => {
		const org = await createTestOrganization({
			name: "Acme",
			visibility: "private",
		});
		const alice = await createTestUser({
			name: "Alice",
			email: "alice@acme.test",
		});
		await addUserToOrganization(alice.id, org.id, "owner");
		const agent = await createTestAgent({ organizationId: org.id });

		// The channel-graph builder auto-creates `person` entities for unmatched
		// members; the type must exist in the org (prod seeds it at org creation).
		const sql = getTestDb();
		await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;

		// Pre-fix sign-in state: $member exists with auth_user_id + email, NO slack_user_id.
		const { memberEntityId } = await provisionMemberAndCoreIdentities(org.id, {
			userId: alice.id,
			email: "alice@acme.test",
			name: "Alice",
		});
		const before = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'slack_user_id' AND deleted_at IS NULL
    `;
		expect(Number(before[0].n)).toBe(0);

		await insertChatConnectionRow({
			id: CONN,
			agentId: agent.agentId,
			platform: "slack",
			organizationId: org.id,
			status: "active",
		});

		// Slack sign-in writes the team-scoped slack_user_id onto the SAME $member.
		await persistLoginSlackIdentity(
			{
				providerId: "slack",
				userId: alice.id,
				accessToken: "xoxp-token",
				accountId: SLACK_USER,
			},
			slackDeps(TEAM),
		);

		// Build the channel graph with Alice as a member of #eng.
		const result = await buildSlackChannelGraph({
			organizationId: org.id,
			connectionId: CONN,
			teamId: TEAM,
			channels: [
				{ channelId: "C01ENG", name: "eng", memberSlackUserIds: [SLACK_USER] },
			],
		});

		// The member edge lands on the EXISTING $member — not a fresh person.
		expect(result.memberEntityIds).toContain(memberEntityId);

		// And no person entity was minted carrying that slack_user_id.
		const personRows = await sql<{ id: number; slug: string }>`
      SELECT e.id, et.slug
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE ei.organization_id = ${org.id}
        AND ei.namespace = 'slack_user_id'
        AND ei.identifier = ${`${TEAM}:${SLACK_USER}`}
        AND ei.deleted_at IS NULL
        AND e.deleted_at IS NULL
    `;
		// Exactly one entity carries the slack id, and it is the $member.
		expect(personRows).toHaveLength(1);
		expect(personRows[0].slug).toBe("$member");
		expect(Number(personRows[0].id)).toBe(memberEntityId);
	});
});
