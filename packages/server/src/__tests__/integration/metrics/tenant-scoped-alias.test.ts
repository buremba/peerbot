import { beforeEach, describe, expect, it } from "vitest";
import {
	IDENTITY_SCOPE_BY_ALIAS_METADATA_KEY,
	SCOPED_IDENTITY_ALIASES_METADATA_KEY,
} from "../../../identity/scope-projection";
import { runMetric } from "../../../metrics/run-metric";
import {
	applyEventAttributions,
	clearEntityLinkRulesCache,
} from "../../../utils/entity-link-upsert";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestConnectorDefinition,
	createTestEvent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";
import { TestApiClient } from "../../setup/test-mcp-client";

const connectorKey = "tenant-metric-contract";
const namespace = "erp_customer";

describe("metric compiler tenant-scoped aliases", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		clearEntityLinkRulesCache();
	});

	it("attributes equal aliases only to the entity in the matching tenant", async () => {
		const org = await createTestOrganization({ name: "Tenant metric org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, org.id, "owner");
		const owner = await TestApiClient.for({
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
		});
		await owner.entity_schema.createType({
			slug: "customer",
			name: "Customer",
			metrics_config: {
				eventSets: {
					observations: {
						by: "alias",
						field: `metadata->>'${namespace}'`,
					},
				},
			measures: {
				observations: {
					eventSet: "observations",
					agg: "count",
					description: "Observed customer events in this upstream tenant.",
				},
			},
			},
		});
		await createTestConnectorDefinition({
			key: connectorKey,
			name: "Tenant metric connector",
			organization_id: org.id,
			feeds_schema: {
				customers: {
					eventKinds: {
						customer: {
							attributions: [
								{
									role: "about",
									autoCreate: true,
									target: {
										entityType: "customer",
										titlePath: "metadata.name",
										identities: [
											{
												namespace,
												eventPath: "metadata.customer_code",
												scope: "tenant",
												scopeKeyPath: "metadata.tenant_id",
											},
										],
									},
								},
							],
						},
					},
				},
			},
		});
		clearEntityLinkRulesCache();

		const items = [
			{
				origin_type: "customer",
				metadata: {
					customer_code: "SHARED-001",
					tenant_id: "tenant-a",
					name: "Customer A",
				},
			},
			{
				origin_type: "customer",
				metadata: {
					customer_code: "SHARED-001",
					tenant_id: "tenant-b",
					name: "Customer B",
				},
			},
		];
		await applyEventAttributions({
			connectorKey,
			feedKey: "customers",
			orgId: org.id,
			items,
		});
		for (const item of items) {
			await createTestEvent({
				organization_id: org.id,
				content: String(item.metadata.name),
				connector_key: connectorKey,
				metadata: item.metadata,
			});
		}

		expect(items[0]?.metadata[IDENTITY_SCOPE_BY_ALIAS_METADATA_KEY]).toEqual({
			"SHARED-001": "tenant-a",
		});
		expect(items[1]?.metadata[IDENTITY_SCOPE_BY_ALIAS_METADATA_KEY]).toEqual({
			"SHARED-001": "tenant-b",
		});
		const rows = await runMetric({
			organizationId: org.id,
			entityType: "customer",
			measure: "observations",
		});
		expect(rows.map((row) => Number(row.observations)).sort()).toEqual([1, 1]);

		const entities = await getTestDb()<
			{ aliases: unknown; scoped_aliases: unknown }[]
		>`
      SELECT metadata->'aliases' AS aliases,
             metadata->${SCOPED_IDENTITY_ALIASES_METADATA_KEY} AS scoped_aliases
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id}
        AND et.slug = 'customer'
        AND e.deleted_at IS NULL
      ORDER BY e.id
    `;
		expect(entities).toHaveLength(2);
		expect(
			entities.every(
				(entity) =>
					!Array.isArray(entity.aliases) || entity.aliases.length === 0,
			),
		).toBe(true);
		expect(entities.map((entity) => entity.scoped_aliases)).toEqual([
			[{ namespace, identifier: "SHARED-001", scopeKey: "tenant-a" }],
			[{ namespace, identifier: "SHARED-001", scopeKey: "tenant-b" }],
		]);
	});
});
