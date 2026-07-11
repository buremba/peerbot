/**
 * Channel business-context (`about` edges) contract.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	slackAclSource,
	slackChannelKey,
	slackChannelsToResources,
} from "@lobu/connectors/slack-identity";
import {
	ABOUT_EDGE_SOURCE_CONFIG,
	ensureAboutRelationshipType,
	listChannelEntitiesAboutBusinessEntity,
	syncConnectionChannelAboutEdges,
} from "../../../authz/channel-about";
import { buildAccessGraph } from "../../../authz/access-graph";
import { clearEntityLinkRulesCache } from "../../../utils/entity-link-upsert";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEAM = "T01ABC";
const CHANNEL = "C01ENG";

async function ensureType(
	orgId: string,
	slug: string,
	name: string,
): Promise<void> {
	const sql = getTestDb();
	await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${orgId}, ${slug}, ${name}, current_timestamp, current_timestamp)
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
  `;
}

async function aboutEdges(orgId: string) {
	const sql = getTestDb();
	return sql<
		{ from_entity_id: number; to_entity_id: number; source: string | null }[]
	>`
    SELECT r.from_entity_id, r.to_entity_id, r.source
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.organization_id = ${orgId}
      AND rt.slug = 'about'
      AND r.deleted_at IS NULL
    ORDER BY r.from_entity_id, r.to_entity_id
  `;
}

describe("channel about edges", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		clearEntityLinkRulesCache();
	});

	it("config about edge survives slack channel graph membership re-sync", async () => {
		const org = await createTestOrganization({ name: "About Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await ensureType(org.id, "person", "Person");
		await ensureType(org.id, "company", "Company");

		const company = await createTestEntity({
			name: "Acme",
			entity_type: "company",
			organization_id: org.id,
			created_by: user.id,
		});

		const connectionId = "conn-about-1";
		await syncConnectionChannelAboutEdges({
			organizationId: org.id,
			connectionId,
			connectorKey: "slack",
			channels: [
				{
					channelId: CHANNEL,
					teamId: TEAM,
					aboutEntityIds: [company.id],
				},
			],
			userId: user.id,
		});

		const before = await aboutEdges(org.id);
		expect(before).toHaveLength(1);
		expect(Number(before[0].to_entity_id)).toBe(company.id);
		expect(before[0].source).toBe(ABOUT_EDGE_SOURCE_CONFIG);

		await buildAccessGraph({
			organizationId: org.id,
			connectionId,
			connectorKey: slackAclSource.key,
			resourceType: slackAclSource.resourceType,
			memberIdentities: slackAclSource.memberIdentities,
			resources: slackChannelsToResources(TEAM, [
				{
					channelId: CHANNEL,
					name: "eng",
					memberSlackUserIds: [],
				},
			]),
		});

		const after = await aboutEdges(org.id);
		expect(after).toHaveLength(1);
		expect(Number(after[0].to_entity_id)).toBe(company.id);
	});

	it("reverse lookup lists channel entities about a business entity", async () => {
		const org = await createTestOrganization({ name: "Reverse Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		await ensureType(org.id, "company", "Company");

		const company = await createTestEntity({
			name: "Beta Co",
			entity_type: "company",
			organization_id: org.id,
			created_by: user.id,
		});

		await syncConnectionChannelAboutEdges({
			organizationId: org.id,
			connectionId: "99",
			connectorKey: "slack",
			channels: [{ channelId: CHANNEL, teamId: TEAM, aboutEntityIds: [company.id] }],
		});

		const channels = await listChannelEntitiesAboutBusinessEntity({
			organizationId: org.id,
			businessEntityId: company.id,
		});
		expect(channels).toHaveLength(1);
		expect(channels[0].connectionId).toBe("99");
		expect(channels[0].channelKey).toBe(slackChannelKey(TEAM, CHANNEL));
		await ensureAboutRelationshipType(org.id);
	});
});
