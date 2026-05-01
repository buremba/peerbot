/**
 * Identity engine integration tests.
 *
 * Covers UC1 / UC4 / UC5 / UC6 / UC8 / UC10 from the F1 design plan plus
 * basic schema-validation guards. Each test runs against a freshly-cleaned
 * test DB; the pglite backend is fast enough that the per-test setup cost
 * is acceptable.
 *
 * The engine's job is narrow: given a `$member` and a batch of facts,
 * persist facts as fact-typed events, supersede prior facts, derive
 * relationships per relationship-type rules, and revoke stale derivations.
 * Adoption (binding the user to a curated `$member`) lives upstream — these
 * tests pre-create the `$member` directly.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	clearIdentityFieldCache,
	ingestFacts,
} from "../../../identity/engine";
import { compileRulesMetadata } from "../../../identity/rules";
import { connectorCapabilityRegistry } from "../../../identity/capability-registry";
import {
	IDENTITY_FACT_SEMANTIC_TYPE,
	CLAIM_COLLISION_SEMANTIC_TYPE,
	type AutoCreateWhenRule,
	type ConnectorFact,
} from "@lobu/connector-sdk";
import { IdentitySchemaError } from "../../../identity/validate";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestEntity,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

interface TestRelationshipType {
	id: number;
	slug: string;
	ruleVersion: number;
	ruleHash: string;
}

async function createPublicCatalog(name: string) {
	return createTestOrganization({ name, visibility: "public" });
}

/**
 * Mark `metadata->>$field` on entity-type `slug` as participating in
 * identity lookup. The engine's `loadIdentityFields()` reads this
 * declaration to allow rules to target the field.
 */
async function declareIdentityField(
	organizationId: string,
	entityTypeSlug: string,
	field: string,
): Promise<void> {
	const sql = getTestDb();
	let typeRows = await sql<{ id: number; metadata_schema: unknown }[]>`
    SELECT id, metadata_schema FROM entity_types
    WHERE organization_id = ${organizationId}
      AND slug = ${entityTypeSlug}
      AND deleted_at IS NULL
    LIMIT 1
  `;
	if (typeRows.length === 0) {
		typeRows = await sql<{ id: number; metadata_schema: unknown }[]>`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${organizationId}, ${entityTypeSlug}, ${entityTypeSlug}, current_timestamp, current_timestamp)
      RETURNING id, metadata_schema
    `;
	}
	const existing = (typeRows[0].metadata_schema ?? null) as {
		properties?: Record<string, Record<string, unknown>>;
	} | null;
	const props = { ...(existing?.properties ?? {}) };
	props[field] = {
		...(props[field] ?? { type: "string" }),
		"x-identity-namespace": true,
	};
	const next = { ...(existing ?? { type: "object" }), properties: props };
	await sql`
    UPDATE entity_types
    SET metadata_schema = ${sql.json(next)}, updated_at = current_timestamp
    WHERE id = ${typeRows[0].id}
  `;
}

async function createRelationshipTypeWithRules(options: {
	organizationId: string;
	slug: string;
	name: string;
	rules: AutoCreateWhenRule[];
	ruleVersion?: number;
}): Promise<TestRelationshipType> {
	const sql = getTestDb();
	const metadata = compileRulesMetadata(
		options.rules,
		options.ruleVersion ?? 1,
	);
	const [row] = await sql<{ id: number }[]>`
    INSERT INTO entity_relationship_types (
      organization_id, slug, name, is_symmetric, status, metadata, created_at, updated_at
    ) VALUES (
      ${options.organizationId},
      ${options.slug},
      ${options.name},
      false,
      'active',
      ${sql.json(metadata)},
      current_timestamp,
      current_timestamp
    )
    RETURNING id
  `;
	return {
		id: Number(row.id),
		slug: options.slug,
		ruleVersion: metadata.ruleVersion,
		ruleHash: metadata.ruleHash,
	};
}

async function createMemberEntity(options: {
	organizationId: string;
	userId: string;
	email: string;
	name: string;
}) {
	const sql = getTestDb();
	// Ensure $member entity_type exists in this org.
	let typeRows = await sql<{ id: number }[]>`
    SELECT id FROM entity_types
    WHERE slug = '$member' AND organization_id = ${options.organizationId} AND deleted_at IS NULL
    LIMIT 1
  `;
	if (typeRows.length === 0) {
		typeRows = await sql<{ id: number }[]>`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${options.organizationId}, '$member', 'Member', current_timestamp, current_timestamp)
      RETURNING id
    `;
	}
	const [inserted] = await sql<{ id: number }[]>`
    INSERT INTO entities (
      name, slug, entity_type_id, organization_id, metadata, created_by, created_at, updated_at
    ) VALUES (
      ${options.name},
      ${`member-${options.userId.slice(-8)}`},
      ${typeRows[0].id},
      ${options.organizationId},
      ${sql.json({ email: options.email, name: options.name })},
      ${options.userId},
      NOW(), NOW()
    )
    RETURNING id
  `;
	return Number(inserted.id);
}

async function getEvent(id: number) {
	const sql = getTestDb();
	const rows = await sql<
		{
			id: string;
			semantic_type: string;
			metadata: Record<string, unknown>;
			supersedes_event_id: string | null;
		}[]
	>`
    SELECT id, semantic_type, metadata, supersedes_event_id
    FROM events WHERE id = ${id} LIMIT 1
  `;
	if (rows.length === 0) return null;
	const r = rows[0];
	return {
		id: Number(r.id),
		semantic_type: r.semantic_type,
		metadata: r.metadata,
		supersedes_event_id:
			r.supersedes_event_id !== null ? Number(r.supersedes_event_id) : null,
	};
}

async function getRelationship(id: number) {
	const sql = getTestDb();
	const rows = await sql<
		{
			id: string;
			from_entity_id: string;
			to_entity_id: string;
			relationship_type_id: string;
			metadata: Record<string, unknown>;
			deleted_at: string | null;
		}[]
	>`
    SELECT id, from_entity_id, to_entity_id, relationship_type_id, metadata, deleted_at
    FROM entity_relationships WHERE id = ${id} LIMIT 1
  `;
	if (rows.length === 0) return null;
	const r = rows[0];
	return {
		id: Number(r.id),
		from_entity_id: Number(r.from_entity_id),
		to_entity_id: Number(r.to_entity_id),
		relationship_type_id: Number(r.relationship_type_id),
		metadata: r.metadata,
		deleted_at: r.deleted_at,
	};
}

describe("identity engine — facts ingestion", () => {
	beforeAll(async () => {
		await cleanupTestDatabase();
		// Register a fully-permissive test connector so the capability
		// registry doesn't reject test facts coming from synthesized
		// connector keys (google_workspace, linkedin, etc.).
		for (const connectorKey of [
			"google_workspace",
			"linkedin",
			"cookies_only_connector",
			"broken",
		]) {
			connectorCapabilityRegistry.register(
				{
					capability: {
						connectorKey,
						produces: [
							{ namespace: "email", assurance: "oauth_verified" },
							{ namespace: "hosted_domain", assurance: "oauth_verified" },
							{
								namespace: "workspace_admin_domain",
								assurance: "oauth_verified_admin_role",
							},
							{ namespace: "linkedin_url", assurance: "oauth_verified" },
							{ namespace: "topic_tag", assurance: "oauth_verified" },
						],
					},
					emit: async () => null,
				},
				{ replace: true },
			);
		}
	});

	beforeEach(async () => {
		await cleanupTestDatabase();
		clearIdentityFieldCache();
	});

	it("UC1: persists a fact event and derives a relationship to a metadata-matching catalog entity", async () => {
		const market = await createPublicCatalog("Market UC1");
		const tenant = await createTestOrganization({
			name: "Tenant UC1",
			visibility: "private",
		});
		const user = await createTestUser({ email: "albertpai@bolt.new" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Albert Pai",
		});

		const company = await createTestEntity({
			name: "Bolt.new",
			entity_type: "company",
			organization_id: market.id,
			domain: "bolt.new",
			created_by: user.id,
		});
		await declareIdentityField(market.id, "company", "domain");
		clearIdentityFieldCache();

		const works_at = await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "domain",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});

		const fact: ConnectorFact = {
			namespace: "hosted_domain",
			identifier: "bolt.new",
			normalizedValue: "bolt.new",
			assurance: "oauth_verified",
			providerStableId: "google:sub:106789",
			sourceAccountId: "acct_uc1_google",
		};

		const result = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "google_workspace",
				providerStableId: "google:sub:106789",
				sourceAccountId: "acct_uc1_google",
			},
			facts: [fact],
			options: { shadow: false },
		});

		expect(result.factEventIds).toHaveLength(1);
		expect(result.derivedRelationshipIds).toHaveLength(1);
		expect(result.collisionEventIds).toHaveLength(0);

		const ev = await getEvent(result.factEventIds[0]);
		expect(ev?.semantic_type).toBe(IDENTITY_FACT_SEMANTIC_TYPE);
		expect(ev?.metadata.namespace).toBe("hosted_domain");
		expect(ev?.metadata.normalizedValue).toBe("bolt.new");
		expect(ev?.metadata.providerStableId).toBe("google:sub:106789");

		const rel = await getRelationship(result.derivedRelationshipIds[0]);
		expect(rel?.from_entity_id).toBe(memberEntityId);
		expect(rel?.to_entity_id).toBe(company.id);
		expect(rel?.relationship_type_id).toBe(works_at.id);
		expect(rel?.deleted_at).toBeNull();
		const derived = (
			rel?.metadata as {
				derivedFrom: { sourceEventId: number; ruleVersion: number };
			}
		).derivedFrom;
		expect(derived.sourceEventId).toBe(result.factEventIds[0]);
		expect(derived.ruleVersion).toBe(works_at.ruleVersion);
	});

	it("UC4: refresh that drops a namespace supersedes the fact and revokes the derivation", async () => {
		const market = await createPublicCatalog("Market UC4");
		const tenant = await createTestOrganization({
			name: "Tenant UC4",
			visibility: "private",
		});
		const user = await createTestUser({ email: "leaver@bolt.new" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Leaver",
		});
		const company = await createTestEntity({
			name: "Bolt.new",
			entity_type: "company",
			organization_id: market.id,
			domain: "bolt.new",
			created_by: user.id,
		});
		await declareIdentityField(market.id, "company", "domain");
		clearIdentityFieldCache();
		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "domain",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});

		const initialFact: ConnectorFact = {
			namespace: "hosted_domain",
			identifier: "bolt.new",
			normalizedValue: "bolt.new",
			assurance: "oauth_verified",
			providerStableId: "google:sub:leaver",
			sourceAccountId: "acct_uc4_google",
		};
		const first = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "google_workspace",
				providerStableId: "google:sub:leaver",
				sourceAccountId: "acct_uc4_google",
			},
			facts: [initialFact],
		});
		expect(first.derivedRelationshipIds).toHaveLength(1);

		// Refresh: hosted_domain is no longer present. Pass a different fact
		// (email) to demonstrate that absent namespaces from prior get
		// tombstoned even when the batch is non-empty.
		const refresh = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "google_workspace",
				providerStableId: "google:sub:leaver",
				sourceAccountId: "acct_uc4_google",
			},
			facts: [
				{
					namespace: "email",
					identifier: "leaver@personal.example",
					normalizedValue: "leaver@personal.example",
					assurance: "oauth_verified",
					providerStableId: "google:sub:leaver",
					sourceAccountId: "acct_uc4_google",
				},
			],
		});

		expect(refresh.supersededEventIds).toContain(first.factEventIds[0]);
		expect(refresh.revokedRelationshipIds).toContain(
			first.derivedRelationshipIds[0],
		);

		const rel = await getRelationship(first.derivedRelationshipIds[0]);
		expect(rel?.deleted_at).not.toBeNull();
	});

	it("UC6: ambiguous match with strategy=unique_only surfaces a claim_collision event and skips derivation", async () => {
		const market = await createPublicCatalog("Market UC6");
		const tenant = await createTestOrganization({
			name: "Tenant UC6",
			visibility: "private",
		});
		const user = await createTestUser({ email: "ambiguous@bolt.new" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Ambiguous",
		});
		// Two founders, same linkedin URL (e.g. mistakenly duplicated). Use a
		// metadata field WITHOUT a unique-index constraint so the test can
		// create two rows that share the value — the engine's job is to
		// detect ambiguity at match time, not at write time.
		const sql = getTestDb();
		const founderA = await createTestEntity({
			name: "Albert (canonical)",
			entity_type: "founder",
			organization_id: market.id,
			created_by: user.id,
		});
		await sql`
      UPDATE entities SET metadata = metadata || ${sql.json({ linkedin_url: "linkedin.com/in/albert" })}
      WHERE id = ${founderA.id}
    `;
		const founderB = await createTestEntity({
			name: "Albert (duplicate)",
			entity_type: "founder",
			organization_id: market.id,
			created_by: user.id,
		});
		await sql`
      UPDATE entities SET metadata = metadata || ${sql.json({ linkedin_url: "linkedin.com/in/albert" })}
      WHERE id = ${founderB.id}
    `;
		await declareIdentityField(market.id, "founder", "linkedin_url");
		clearIdentityFieldCache();

		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "is_same_person_as",
			name: "Is same person as",
			rules: [
				{
					sourceNamespace: "linkedin_url",
					targetField: "linkedin_url",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});

		const result = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "linkedin",
				providerStableId: "linkedin:12345",
				sourceAccountId: "acct_uc6_linkedin",
			},
			facts: [
				{
					namespace: "linkedin_url",
					identifier: "https://linkedin.com/in/albert",
					normalizedValue: "linkedin.com/in/albert",
					assurance: "oauth_verified",
					providerStableId: "linkedin:12345",
					sourceAccountId: "acct_uc6_linkedin",
				},
			],
		});

		expect(result.derivedRelationshipIds).toHaveLength(0);
		expect(result.collisionEventIds).toHaveLength(1);
		expect(result.skippedRules.length).toBeGreaterThan(0);

		const ev = await getEvent(result.collisionEventIds[0]);
		expect(ev?.semantic_type).toBe(CLAIM_COLLISION_SEMANTIC_TYPE);
		const payload = ev?.metadata as {
			kind: string;
			candidateEntityIds: number[];
		};
		expect(payload.kind).toBe("identity_match");
		expect(payload.candidateEntityIds).toHaveLength(2);
	});

	it("unique_only filters metadata matches through relationship type rules before declaring a collision", async () => {
		const market = await createPublicCatalog("Market Type Filter");
		const tenant = await createTestOrganization({
			name: "Tenant Type Filter",
			visibility: "private",
		});
		const user = await createTestUser({ email: "typed@bolt.new" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Typed",
		});
		const company = await createTestEntity({
			name: "Bolt.new",
			entity_type: "company",
			organization_id: market.id,
			created_by: user.id,
		});
		const unrelated = await createTestEntity({
			name: "Unrelated taxonomy row",
			entity_type: "sector",
			organization_id: market.id,
			created_by: user.id,
		});
		const sql = getTestDb();
		await sql`
      UPDATE entities SET metadata = metadata || ${sql.json({ identity_key: "bolt.new" })}
      WHERE id IN (${company.id}, ${unrelated.id})
    `;
		await declareIdentityField(market.id, "company", "identity_key");
		clearIdentityFieldCache();
		const works_at = await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "identity_key",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});
		await sql`
      INSERT INTO entity_relationship_type_rules (
        relationship_type_id, source_entity_type_slug, target_entity_type_slug, created_at
      ) VALUES (${works_at.id}, '$member', 'company', current_timestamp)
    `;

		const result = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "google_workspace",
				providerStableId: "google:sub:type-filter",
				sourceAccountId: "acct_type_filter",
			},
			facts: [
				{
					namespace: "hosted_domain",
					identifier: "bolt.new",
					normalizedValue: "bolt.new",
					assurance: "oauth_verified",
					providerStableId: "google:sub:type-filter",
					sourceAccountId: "acct_type_filter",
				},
			],
		});

		expect(result.collisionEventIds).toHaveLength(0);
		expect(result.derivedRelationshipIds).toHaveLength(1);
		const rel = await getRelationship(result.derivedRelationshipIds[0]);
		expect(rel?.to_entity_id).toBe(company.id);
	});

	it("caps and dedupes repeated claim-collision events", async () => {
		const market = await createPublicCatalog("Market Collision Cap");
		const tenant = await createTestOrganization({
			name: "Tenant Collision Cap",
			visibility: "private",
		});
		const user = await createTestUser({ email: "collision-cap@example.com" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Collision Cap",
		});
		const sql = getTestDb();
		for (let i = 0; i < 17; i++) {
			const entity = await createTestEntity({
				name: `Duplicate ${i}`,
				entity_type: "company",
				organization_id: market.id,
				created_by: user.id,
			});
			await sql`
        UPDATE entities SET metadata = metadata || ${sql.json({ dupe_key: "dupe.test" })}
        WHERE id = ${entity.id}
      `;
		}
		await declareIdentityField(market.id, "company", "dupe_key");
		clearIdentityFieldCache();
		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "dupe_key",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});
		const accountIdentity = {
			connectorKey: "google_workspace",
			providerStableId: "google:sub:collision-cap",
			sourceAccountId: "acct_collision_cap",
		};
		const fact: ConnectorFact = {
			namespace: "hosted_domain",
			identifier: "dupe.test",
			normalizedValue: "dupe.test",
			assurance: "oauth_verified",
			providerStableId: accountIdentity.providerStableId,
			sourceAccountId: accountIdentity.sourceAccountId,
		};

		const first = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity,
			facts: [fact],
		});
		const second = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity,
			facts: [fact],
		});

		expect(first.collisionEventIds).toHaveLength(1);
		expect(second.collisionEventIds).toEqual(first.collisionEventIds);
		const [eventCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM events
      WHERE semantic_type = ${CLAIM_COLLISION_SEMANTIC_TYPE}
    `;
		expect(Number(eventCount.count)).toBe(1);
		const ev = await getEvent(first.collisionEventIds[0]);
		const payload = ev?.metadata as {
			candidateEntityIds: number[];
			candidateCount: number;
		};
		expect(payload.candidateEntityIds).toHaveLength(16);
		expect(payload.candidateCount).toBe(17);
	});

	it("rejects duplicate namespace/value facts in the same batch", async () => {
		const tenant = await createTestOrganization({
			name: "Tenant Duplicate Fact",
			visibility: "private",
		});
		const user = await createTestUser({ email: "dupe-fact@example.com" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Duplicate Fact",
		});
		const accountIdentity = {
			connectorKey: "google_workspace",
			providerStableId: "google:sub:dupe-fact",
			sourceAccountId: "acct_dupe_fact",
		};
		const fact: ConnectorFact = {
			namespace: "email",
			identifier: "dupe-fact@example.com",
			normalizedValue: "dupe-fact@example.com",
			assurance: "oauth_verified",
			providerStableId: accountIdentity.providerStableId,
			sourceAccountId: accountIdentity.sourceAccountId,
		};

		await expect(
			ingestFacts({
				tenantOrganizationId: tenant.id,
				memberEntityId,
				userId: user.id,
				accountIdentity,
				facts: [fact, { ...fact, identifier: "Dupe Fact <dupe-fact@example.com>" }],
			}),
		).rejects.toThrow(/duplicate fact/);
	});

	it("UC8: rejects a fact whose assurance is below the rule requirement", async () => {
		const market = await createPublicCatalog("Market UC8");
		const tenant = await createTestOrganization({
			name: "Tenant UC8",
			visibility: "private",
		});
		const user = await createTestUser({ email: "lowtrust@example.com" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Lowtrust",
		});
		await createTestEntity({
			name: "Bolt.new",
			entity_type: "company",
			organization_id: market.id,
			domain: "bolt.new",
			created_by: user.id,
		});
		await declareIdentityField(market.id, "company", "domain");
		clearIdentityFieldCache();
		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "domain",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});

		const result = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "cookies_only_connector",
				providerStableId: "cookie:abc",
				sourceAccountId: "acct_uc8_cookies",
			},
			facts: [
				{
					namespace: "hosted_domain",
					identifier: "bolt.new",
					normalizedValue: "bolt.new",
					assurance: "cookie_session",
					providerStableId: "cookie:abc",
					sourceAccountId: "acct_uc8_cookies",
				},
			],
		});

		expect(result.factEventIds).toHaveLength(1);
		expect(result.derivedRelationshipIds).toHaveLength(0);
		expect(
			result.skippedRules.some((s) => s.reason.includes("below required")),
		).toBe(true);
	});

	it("shadow mode: writes facts but skips derivation/revocation", async () => {
		const market = await createPublicCatalog("Market Shadow");
		const tenant = await createTestOrganization({
			name: "Tenant Shadow",
			visibility: "private",
		});
		const user = await createTestUser({ email: "shadow@bolt.new" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Shadow",
		});
		await createTestEntity({
			name: "Bolt.new",
			entity_type: "company",
			organization_id: market.id,
			domain: "bolt.new",
			created_by: user.id,
		});
		await declareIdentityField(market.id, "company", "domain");
		clearIdentityFieldCache();
		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "domain",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});

		const result = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "google_workspace",
				providerStableId: "google:sub:shadow",
				sourceAccountId: "acct_shadow_google",
			},
			facts: [
				{
					namespace: "hosted_domain",
					identifier: "bolt.new",
					normalizedValue: "bolt.new",
					assurance: "oauth_verified",
					providerStableId: "google:sub:shadow",
					sourceAccountId: "acct_shadow_google",
				},
			],
			options: { shadow: true },
		});

		expect(result.factEventIds).toHaveLength(1);
		expect(result.derivedRelationshipIds).toHaveLength(0);
		expect(result.revokedRelationshipIds).toHaveLength(0);
		expect(result.collisionEventIds).toHaveLength(0);
	});

	it("rejects malformed facts with IdentitySchemaError before any side effects", async () => {
		const tenant = await createTestOrganization({
			name: "Tenant Malformed",
			visibility: "private",
		});
		const user = await createTestUser({ email: "malformed@example.com" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Malformed",
		});

		await expect(
			ingestFacts({
				tenantOrganizationId: tenant.id,
				memberEntityId,
				userId: user.id,
				accountIdentity: {
					connectorKey: "broken",
					providerStableId: "broken:1",
					sourceAccountId: "broken:1",
				},
				facts: [
					// Missing required fields.
					{
						namespace: "",
						identifier: "",
						normalizedValue: "",
						assurance: "oauth_verified",
						providerStableId: "",
						sourceAccountId: "",
					} as ConnectorFact,
				],
			}),
		).rejects.toBeInstanceOf(IdentitySchemaError);
	});

	it("UC5: same connector emitting an admin-tier namespace fires a separate is_admin_of rule", async () => {
		const market = await createPublicCatalog("Market UC5");
		const tenant = await createTestOrganization({
			name: "Tenant UC5",
			visibility: "private",
		});
		const user = await createTestUser({ email: "admin@bolt.new" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Admin User",
		});
		const company = await createTestEntity({
			name: "Bolt.new",
			entity_type: "company",
			organization_id: market.id,
			domain: "bolt.new",
			created_by: user.id,
		});
		await declareIdentityField(market.id, "company", "domain");
		clearIdentityFieldCache();

		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "domain",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});
		const is_admin_of = await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "is_admin_of",
			name: "Is admin of",
			rules: [
				{
					sourceNamespace: "workspace_admin_domain",
					targetField: "domain",
					assuranceRequired: "oauth_verified_admin_role",
					matchStrategy: "unique_only",
				},
			],
		});

		const result = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "google_workspace",
				providerStableId: "google:sub:admin",
				sourceAccountId: "acct_uc5_google",
			},
			facts: [
				{
					namespace: "hosted_domain",
					identifier: "bolt.new",
					normalizedValue: "bolt.new",
					assurance: "oauth_verified",
					providerStableId: "google:sub:admin",
					sourceAccountId: "acct_uc5_google",
				},
				{
					namespace: "workspace_admin_domain",
					identifier: "bolt.new",
					normalizedValue: "bolt.new",
					assurance: "oauth_verified_admin_role",
					providerStableId: "google:sub:admin",
					sourceAccountId: "acct_uc5_google",
				},
			],
		});

		expect(result.derivedRelationshipIds.length).toBeGreaterThanOrEqual(2);
		const sql = getTestDb();
		const rels = await sql<
			{
				id: number;
				relationship_type_id: number;
			}[]
		>`
      SELECT id, relationship_type_id
      FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId}
        AND to_entity_id = ${company.id}
        AND deleted_at IS NULL
    `;
		const relTypeIds = rels.map((r) => r.relationship_type_id);
		expect(relTypeIds).toContain(is_admin_of.id);
	});

	it("UC2: a refresh that changes a namespace value supersedes the old fact and re-derives to the new target", async () => {
		const market = await createPublicCatalog("Market UC2");
		const tenant = await createTestOrganization({
			name: "Tenant UC2",
			visibility: "private",
		});
		const user = await createTestUser({ email: "mover@bolt.new" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Mover",
		});
		const oldCompany = await createTestEntity({
			name: "Old Co",
			entity_type: "company",
			organization_id: market.id,
			domain: "oldco.com",
			created_by: user.id,
		});
		const newCompany = await createTestEntity({
			name: "New Co",
			entity_type: "company",
			organization_id: market.id,
			domain: "newco.com",
			created_by: user.id,
		});
		await declareIdentityField(market.id, "company", "domain");
		clearIdentityFieldCache();
		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "domain",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});

		const accountIdentity = {
			connectorKey: "google_workspace",
			providerStableId: "google:sub:mover",
			sourceAccountId: "acct_uc2",
		};

		const first = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity,
			facts: [
				{
					namespace: "hosted_domain",
					identifier: "oldco.com",
					normalizedValue: "oldco.com",
					assurance: "oauth_verified",
					providerStableId: accountIdentity.providerStableId,
					sourceAccountId: accountIdentity.sourceAccountId,
				},
			],
		});
		expect(first.derivedRelationshipIds).toHaveLength(1);

		const second = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity,
			facts: [
				{
					namespace: "hosted_domain",
					identifier: "newco.com",
					normalizedValue: "newco.com",
					assurance: "oauth_verified",
					providerStableId: accountIdentity.providerStableId,
					sourceAccountId: accountIdentity.sourceAccountId,
				},
			],
		});
		expect(second.supersededEventIds).toHaveLength(1);
		expect(second.revokedRelationshipIds).toHaveLength(1);
		expect(second.derivedRelationshipIds).toHaveLength(1);

		const sql = getTestDb();
		const liveRels = await sql<{ to_entity_id: number }[]>`
      SELECT to_entity_id FROM entity_relationships
      WHERE from_entity_id = ${memberEntityId} AND deleted_at IS NULL
    `;
		expect(liveRels.map((r) => Number(r.to_entity_id))).toEqual([
			newCompany.id,
		]);
		expect(liveRels.map((r) => Number(r.to_entity_id))).not.toContain(
			oldCompany.id,
		);
	});

	it("UC7: all_matches strategy fans out to every matching entity", async () => {
		const market = await createPublicCatalog("Market UC7");
		const tenant = await createTestOrganization({
			name: "Tenant UC7",
			visibility: "private",
		});
		const user = await createTestUser({ email: "fanout@example.com" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Fanout",
		});
		const sql = getTestDb();
		const tagged = [
			await createTestEntity({
				name: "Co A",
				entity_type: "company",
				organization_id: market.id,
				created_by: user.id,
			}),
			await createTestEntity({
				name: "Co B",
				entity_type: "company",
				organization_id: market.id,
				created_by: user.id,
			}),
		];
		for (const e of tagged) {
			await sql`
        UPDATE entities SET metadata = metadata || ${sql.json({ topic_tag: "genai" })}
        WHERE id = ${e.id}
      `;
		}
		await declareIdentityField(market.id, "company", "topic_tag");
		clearIdentityFieldCache();

		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "mentions",
			name: "Mentions",
			rules: [
				{
					sourceNamespace: "topic_tag",
					targetField: "topic_tag",
					assuranceRequired: "oauth_verified",
					matchStrategy: "all_matches",
				},
			],
		});

		const result = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "google_workspace",
				providerStableId: "google:sub:fanout",
				sourceAccountId: "acct_uc7",
			},
			facts: [
				{
					namespace: "topic_tag",
					identifier: "genai",
					normalizedValue: "genai",
					assurance: "oauth_verified",
					providerStableId: "google:sub:fanout",
					sourceAccountId: "acct_uc7",
				},
			],
		});
		expect(result.derivedRelationshipIds).toHaveLength(2);
		expect(result.collisionEventIds).toHaveLength(0);
	});

	it("multi-value namespace: same namespace with two values produces two facts and tombstones independently", async () => {
		const tenant = await createTestOrganization({
			name: "Tenant MV",
			visibility: "private",
		});
		const user = await createTestUser({ email: "multi@example.com" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Multi",
		});
		const accountIdentity = {
			connectorKey: "google_workspace",
			providerStableId: "google:sub:multi",
			sourceAccountId: "acct_mv",
		};
		const factsBoth = [
			{
				namespace: "email",
				identifier: "one@example.com",
				normalizedValue: "one@example.com",
				assurance: "oauth_verified" as const,
				providerStableId: accountIdentity.providerStableId,
				sourceAccountId: accountIdentity.sourceAccountId,
			},
			{
				namespace: "email",
				identifier: "two@example.com",
				normalizedValue: "two@example.com",
				assurance: "oauth_verified" as const,
				providerStableId: accountIdentity.providerStableId,
				sourceAccountId: accountIdentity.sourceAccountId,
			},
		];

		const first = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity,
			facts: factsBoth,
		});
		expect(first.factEventIds).toHaveLength(2);

		const second = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity,
			facts: [factsBoth[0]],
		});
		// The dropped value tombstones; the kept value either no-ops (same
		// normalizedValue) or supersedes itself.
		expect(second.supersededEventIds.length).toBeGreaterThanOrEqual(1);
		const sql = getTestDb();
		const liveFacts = await sql<{ normalized_value: string }[]>`
      SELECT metadata->>'normalizedValue' AS normalized_value
      FROM current_event_records
      WHERE semantic_type = ${IDENTITY_FACT_SEMANTIC_TYPE}
        AND connector_key = ${accountIdentity.connectorKey}
        AND metadata->>'providerStableId' = ${accountIdentity.providerStableId}
        AND COALESCE(metadata->>'normalizedValue', '') <> ''
    `;
		expect(liveFacts.map((r) => r.normalized_value)).toEqual([
			"one@example.com",
		]);
	});

	it("validTo: an expired fact is persisted but never derives a relationship", async () => {
		const market = await createPublicCatalog("Market ValidTo");
		const tenant = await createTestOrganization({
			name: "Tenant ValidTo",
			visibility: "private",
		});
		const user = await createTestUser({ email: "expired@example.com" });
		await addUserToOrganization(user.id, tenant.id, "owner");
		const memberEntityId = await createMemberEntity({
			organizationId: tenant.id,
			userId: user.id,
			email: user.email,
			name: "Expired",
		});
		await createTestEntity({
			name: "Bolt.new",
			entity_type: "company",
			organization_id: market.id,
			domain: "bolt.new",
			created_by: user.id,
		});
		await declareIdentityField(market.id, "company", "domain");
		clearIdentityFieldCache();
		await createRelationshipTypeWithRules({
			organizationId: market.id,
			slug: "works_at",
			name: "Works at",
			rules: [
				{
					sourceNamespace: "hosted_domain",
					targetField: "domain",
					assuranceRequired: "oauth_verified",
					matchStrategy: "unique_only",
				},
			],
		});

		const result = await ingestFacts({
			tenantOrganizationId: tenant.id,
			memberEntityId,
			userId: user.id,
			accountIdentity: {
				connectorKey: "google_workspace",
				providerStableId: "google:sub:expired",
				sourceAccountId: "acct_validto",
			},
			facts: [
				{
					namespace: "hosted_domain",
					identifier: "bolt.new",
					normalizedValue: "bolt.new",
					assurance: "oauth_verified",
					providerStableId: "google:sub:expired",
					sourceAccountId: "acct_validto",
					validTo: "2000-01-01T00:00:00Z",
				},
			],
		});
		expect(result.factEventIds).toHaveLength(1);
		expect(result.derivedRelationshipIds).toHaveLength(0);
		expect(result.skippedRules.some((s) => s.reason.includes("validTo"))).toBe(
			true,
		);
	});
});
