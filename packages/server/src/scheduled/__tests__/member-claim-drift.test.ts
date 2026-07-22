/**
 * Integration test for the $member projection-drift alerter. Seeds three member
 * shapes in one org — healthy (has the $member + auth:signup claim), drifted (no
 * claim at all), and poisoned (an auth_user_id claim owned by a `person`, which
 * the forward path's ON CONFLICT DO NOTHING can never heal) — and asserts the
 * scan counts exactly the drifted and poisoned rows, never the healthy one.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { provisionMemberAndCoreIdentities } from "../../auth/subject-identities";
import { getDb } from "../../db/client";
import {
	ensureDbForGatewayTests,
	resetTestDatabase,
} from "../../gateway/__tests__/helpers/db-setup";
import { runMemberClaimDriftCheck } from "../member-claim-drift";

const ORG_ID = "member-drift-org";

async function seedUserAndMember(userId: string, email: string): Promise<void> {
	const sql = getDb();
	await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, ${email}, ${email}, true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
	await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`m_${userId}`}, ${ORG_ID}, ${userId}, 'member', now())
    ON CONFLICT ("organizationId", "userId") DO NOTHING
  `;
}

describe("member-claim-drift alerter", () => {
	beforeAll(async () => {
		await ensureDbForGatewayTests();
	});

	beforeEach(async () => {
		await resetTestDatabase();
		const sql = getDb();
		await sql`
      INSERT INTO organization (id, name, slug, visibility)
      VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID}, 'private')
      ON CONFLICT (id) DO NOTHING
    `;
	});

	test("counts drifted and poisoned members, never the healthy one", async () => {
		const sql = getDb();

		// HEALTHY: full provisioning path → $member + auth:signup claim.
		await seedUserAndMember("u_healthy", "healthy@acme.test");
		await provisionMemberAndCoreIdentities(ORG_ID, {
			userId: "u_healthy",
			email: "healthy@acme.test",
			name: "Healthy",
		});

		// DRIFTED: member row, no $member entity, no claim.
		await seedUserAndMember("u_drifted", "drifted@acme.test");

		// POISONED: member row + an auth_user_id claim, but owned by a `person`
		// (not a $member). The gate won't resolve it and DO NOTHING can't replace it.
		await seedUserAndMember("u_poison", "poison@acme.test");
		await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${ORG_ID}, 'person', 'Person', now(), now())
      ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND deleted_at IS NULL
      DO NOTHING
    `;
		const person = await sql<{ id: number }>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, created_by, created_at, updated_at)
      VALUES (
        ${ORG_ID},
        (SELECT id FROM entity_types WHERE organization_id = ${ORG_ID} AND slug = 'person' AND deleted_at IS NULL LIMIT 1),
        'Poison Person', 'poison-person', 'u_poison', now(), now()
      )
      RETURNING id
    `;
		await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier, source_connector)
      VALUES (${ORG_ID}, ${person[0].id}, 'auth_user_id', 'u_poison', 'auth:signup')
    `;

		const result = await runMemberClaimDriftCheck();

		// missingClaim = "no resolvable $member + auth:signup claim", which is true
		// for BOTH the drifted row (no claim) and the poisoned row (claim on a
		// person, not a $member) — the gate can't resolve either. poisonClaim then
		// isolates the self-heal-proof subset so the operator knows which rows the
		// forward path can never fix on its own.
		expect(result.missingClaim).toBe(2); // u_drifted + u_poison
		expect(result.poisonClaim).toBe(1); // only u_poison
	});

	test("reports zero when every member has a resolvable claim", async () => {
		await seedUserAndMember("u_ok", "ok@acme.test");
		await provisionMemberAndCoreIdentities(ORG_ID, {
			userId: "u_ok",
			email: "ok@acme.test",
			name: "Ok",
		});

		const result = await runMemberClaimDriftCheck();
		expect(result.missingClaim).toBe(0);
		expect(result.poisonClaim).toBe(0);
	});
});
