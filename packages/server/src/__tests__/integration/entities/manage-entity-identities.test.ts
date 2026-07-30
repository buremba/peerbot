/**
 * `manage_entity` create with identity claims. The prior tool path created an
 * entity without first consulting claims already written by connector ingest.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { manageEntity } from "../../../tools/admin/manage_entity";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const env = {} as Env;

function ctx(orgId: string, userId: string): ToolContext {
	return {
		organizationId: orgId,
		userId,
		memberRole: "owner",
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
	} as ToolContext;
}

type CreateResult = {
	entity?: { id: number };
	attached_to_existing?: boolean;
	warnings?: string[];
};

describe("manage_entity create with identities", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
	});

	async function org() {
		const organization = await createTestOrganization({ name: "Identity Org" });
		const user = await createTestUser();
		await addUserToOrganization(user.id, organization.id, "owner");
		const sql = getTestDb();
		// manage_entity resolves entity_type against a real row (unlike
		// createTestEntity, which auto-ensures one).
		await sql`
			INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
			VALUES (${organization.id}, 'person', 'Person', current_timestamp, current_timestamp)
			ON CONFLICT DO NOTHING
		`;
		return { organization, user, sql };
	}

	async function create(
		orgId: string,
		userId: string,
		name: string,
		identities?: Array<{ namespace: string; identifier: string }>,
	) {
		return (await manageEntity(
			{ action: "create", entity_type: "person", name, identities },
			env,
			ctx(orgId, userId),
		)) as unknown as CreateResult;
	}

	it("records the claims it was given, normalized", async () => {
		const { organization, user, sql } = await org();
		const created = await create(organization.id, user.id, "Esref", [
			{ namespace: " Phone ", identifier: "+90 532 235 65 86" },
		]);

		const rows = await sql`
			SELECT namespace, identifier, source_connector
			FROM entity_identities
			WHERE entity_id = ${created.entity?.id ?? 0} AND deleted_at IS NULL
		`;
		expect(rows).toHaveLength(1);
		// Punctuation stripped by the phone normalizer — stored canonically so the
		// next writer's lookup can actually find it.
		expect(rows[0].identifier).toBe("905322356586");
		expect(rows[0].namespace).toBe("phone");
		expect(rows[0].source_connector).toBe("tool:manage_entity");
	});

	it("attaches to the existing person instead of creating a duplicate", async () => {
		const { organization, user, sql } = await org();
		const first = await create(organization.id, user.id, "Esref", [
			{ namespace: "phone", identifier: "905322356586" },
		]);

		// Same human, a spelling the importer happened to use. This is the exact
		// call that used to mint the duplicate.
		const second = await create(organization.id, user.id, "Esref Kaya", [
			{ namespace: "phone", identifier: "+90 (532) 235 65 86" },
		]);

		expect(second.attached_to_existing).toBe(true);
		expect(second.entity?.id).toBe(first.entity?.id);

		const people = await sql`
			SELECT e.id FROM entities e
			JOIN entity_types t ON t.id = e.entity_type_id
			WHERE e.organization_id = ${organization.id}
			  AND t.slug = 'person' AND e.deleted_at IS NULL
		`;
		expect(people).toHaveLength(1);
	});

	it("serializes concurrent creates for the same new identity", async () => {
		const { organization, user, sql } = await org();
		const [first, second] = await Promise.all([
			create(organization.id, user.id, "Concurrent A", [
				{ namespace: "email", identifier: "race@example.com" },
			]),
			create(organization.id, user.id, "Concurrent B", [
				{ namespace: "email", identifier: "race@example.com" },
			]),
		]);

		expect(first.entity?.id).toBe(second.entity?.id);
		expect(
			[first.attached_to_existing, second.attached_to_existing].filter(Boolean),
		).toHaveLength(1);
		const people = await sql`
			SELECT e.id
			FROM entities e
			JOIN entity_types t ON t.id = e.entity_type_id
			WHERE e.organization_id = ${organization.id}
			  AND t.slug = 'person'
			  AND e.deleted_at IS NULL
		`;
		expect(people).toHaveLength(1);
	});

	it("preserves normalized claims when an agent create is deferred", async () => {
		const { organization, user, sql } = await org();
		const agent = await createTestAgent({
			organizationId: organization.id,
			ownerUserId: user.id,
		});
		// Deferral only happens when policy holds the create for approval.
		// Without this the tool creates immediately and the claims are attached
		// inline, which would leave the deferred payload untested.
		const policy = await sql<{ id: number }>`
			INSERT INTO write_approval_policies
				(organization_id, resource_class, principal_kind, entity_type_slug)
			VALUES (${organization.id}, 'entity', 'agent', 'person')
			RETURNING id
		`;
		await sql`
			INSERT INTO write_policy_action_effects (policy_id, action, effect)
			VALUES (${Number(policy[0].id)}, 'create', 'approval')
		`;
		const result = (await manageEntity(
			{
				action: "create",
				entity_type: "person",
				name: "Deferred Person",
				identities: [
					{ namespace: " Email ", identifier: " Deferred@Example.COM " },
				],
			},
			env,
			{
				...ctx(organization.id, user.id),
				agentId: agent.agentId,
			} as ToolContext,
		)) as unknown as { approval_queued?: boolean; approval_run_id?: number };

		expect(result.approval_queued).toBe(true);
		const rows = await sql`
			SELECT action_input
			FROM runs
			WHERE id = ${result.approval_run_id ?? 0}
		`;
		expect(rows[0].action_input.identity_claims).toEqual([
			{ namespace: "email", identifier: "deferred@example.com" },
		]);
		expect(rows[0].action_input.identity_source_connector).toBe(
			`agent:${agent.agentId}`,
		);
	});

	it("creates normally when nothing claims the identifier", async () => {
		const { organization, user } = await org();
		await create(organization.id, user.id, "Esref", [
			{ namespace: "phone", identifier: "905322356586" },
		]);
		const other = await create(organization.id, user.id, "Dedem", [
			{ namespace: "phone", identifier: "905067888845" },
		]);
		expect(other.attached_to_existing).toBeFalsy();
	});

	it("does NOT match a national-format number to a country-coded one", async () => {
		// The phone normalizer strips punctuation but never guesses a country
		// code, so these stay separate people.
		const { organization, user } = await org();
		const first = await create(organization.id, user.id, "Contact", [
			{ namespace: "phone", identifier: "905324764881" },
		]);
		const second = await create(organization.id, user.id, "Contact 2", [
			{ namespace: "phone", identifier: "05324764881" },
		]);
		expect(second.attached_to_existing).toBeFalsy();
		expect(second.entity?.id).not.toBe(first.entity?.id);
	});

	it("refuses to fuse two existing people in one call", async () => {
		const { organization, user } = await org();
		const a = await create(organization.id, user.id, "Person A", [
			{ namespace: "phone", identifier: "905322356586" },
		]);
		const b = await create(organization.id, user.id, "Person B", [
			{ namespace: "email", identifier: "b@example.com" },
		]);
		expect(a.entity?.id).not.toBe(b.entity?.id);

		// Both identifiers in one create would silently merge two real records.
		await expect(
			create(organization.id, user.id, "Person A or B", [
				{ namespace: "phone", identifier: "905322356586" },
				{ namespace: "email", identifier: "b@example.com" },
			]),
		).rejects.toThrow(/already belong to different entities/i);
	});

	it("ignores a value its namespace cannot parse rather than storing a fake claim", async () => {
		const { organization, user, sql } = await org();
		const created = await create(organization.id, user.id, "Nobody", [
			{ namespace: "phone", identifier: "not a phone number at all" },
			{ namespace: "email", identifier: "also-not-an-email" },
		]);
		const rows = await sql`
			SELECT 1 FROM entity_identities
			WHERE entity_id = ${created.entity?.id ?? 0} AND deleted_at IS NULL
		`;
		expect(rows).toHaveLength(0);
		// The entity is still created — an unparseable value is a display string,
		// not a reason to refuse the write.
		expect(created.entity?.id).toBeGreaterThan(0);
	});


	it("does not let a create-only agent probe for an existing person", async () => {
		// The oracle this guards: an agent denied READ on the type submits a phone
		// it suspects exists. If create resolved, the response would hand back that
		// person's record — turning create into a lookup for data it cannot read.
		const { organization, user, sql } = await org();
		const owner = await create(organization.id, user.id, "Private Person", [
			{ namespace: "phone", identifier: "905551234567" },
		]);
		const agent = await createTestAgent({
			organizationId: organization.id,
			ownerUserId: user.id,
		});
		const policy = await sql<{ id: number }>`
			INSERT INTO write_approval_policies
				(organization_id, resource_class, principal_kind, entity_type_slug)
			VALUES (${organization.id}, 'entity', 'agent', 'person')
			RETURNING id
		`;
		await sql`
			INSERT INTO write_policy_action_effects (policy_id, action, effect)
			VALUES (${Number(policy[0].id)}, 'read', 'deny')
		`;

		const probed = (await manageEntity(
			{
				action: "create",
				entity_type: "person",
				name: "Probe",
				identities: [{ namespace: "phone", identifier: "905551234567" }],
			},
			env,
			{
				...ctx(organization.id, user.id),
				agentId: agent.agentId,
			} as ToolContext,
		)) as unknown as CreateResult;

		// A fresh entity, never the existing one, and no attach signal.
		expect(probed.entity?.id).not.toBe(owner.entity?.id);
		expect(probed.attached_to_existing).toBeFalsy();
		// The contested claim stays with its owner rather than moving.
		const rows = await sql`
			SELECT entity_id FROM entity_identities
			WHERE organization_id = ${organization.id}
			  AND namespace = 'phone' AND identifier = '905551234567'
			  AND deleted_at IS NULL
		`;
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].entity_id)).toBe(owner.entity?.id);
	});
});
