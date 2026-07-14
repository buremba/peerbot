/**
 * manage_entity_schema relationship_type update — `is_symmetric` is create-only.
 *
 * Bug (red→fix→green): `is_symmetric` is persisted on `create` and returned in
 * every SELECT, but `rtHandleUpdate`'s UPDATE SET clause has no `is_symmetric`
 * arm — so an `update` carrying it was silently dropped (the row stayed
 * unchanged, the call returned success). The contract documents `is_symmetric`
 * as `[relationship_type: create]` only, and the field is load-bearing for
 * relationship canonicalization/dedup at write time
 * (`manage_entity.ts:1230` canonicalizes a→b / b→a as one edge when
 * symmetric). Flipping it on a populated type would not migrate existing rows
 * and would change dedup semantics for new ones — so it is intentionally
 * immutable post-create, like watcher version-owned fields.
 *
 * Fix: reject `is_symmetric` on `update` with a pointer to recreate, instead
 * of silently dropping it. (Owletto only sends `is_symmetric` on the create
 * form — `relationship-types-tab.tsx:307` — so this breaks no UI path.)
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import type { AuthContext } from "../../../tools/execute";
import { executeTool } from "../../../tools/execute";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const TEST_ENV: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
	JWT_SECRET: "test-jwt-secret-for-testing-only",
	BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
	MAX_CONSECUTIVE_FAILURES: "3",
	RATE_LIMIT_ENABLED: "false",
};

describe("manage_entity_schema relationship_type update — is_symmetric is create-only", () => {
	let orgId: string;
	let ownerCtx: AuthContext;

	const baseCtx = (orgIdValue: string, userId: string): AuthContext => ({
		organizationId: orgIdValue,
		tokenOrganizationId: orgIdValue,
		userId,
		memberRole: "owner",
		agentId: null,
		requestedAgentId: null,
		isAuthenticated: true,
		clientId: null,
		scopes: ["mcp:read", "mcp:write", "mcp:admin"],
		tokenType: "oauth",
		requestUrl: `http://localhost/api/${orgIdValue}`,
		baseUrl: "",
		scopedToOrg: true,
		allowCrossOrg: false,
	});

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const org = await createTestOrganization({ name: "rel-type is_symmetric" });
		orgId = org.id;
		const owner = await createTestUser({ email: "rt-owner@test.com" });
		await addUserToOrganization(owner.id, org.id, "owner");
		ownerCtx = baseCtx(org.id, owner.id);
	});

	async function createRelType(slug: string, isSymmetric: boolean): Promise<void> {
		await executeTool(
			"manage_entity_schema",
			{
				schema_type: "relationship_type",
				action: "create",
				slug,
				name: slug,
				is_symmetric: isSymmetric,
			},
			TEST_ENV,
			ownerCtx,
		);
	}

	async function fetchIsSymmetric(slug: string): Promise<boolean> {
		const sql = getTestDb();
		const rows = await sql`
			SELECT is_symmetric FROM entity_relationship_types
			WHERE slug = ${slug} AND organization_id = ${orgId}
		`;
		return Boolean((rows[0] as { is_symmetric?: boolean } | undefined)?.is_symmetric);
	}

	it("rejects `update` with is_symmetric (create-only) — points to recreate", async () => {
		await createRelType("symmetric-then-flip", true);
		await expect(
			executeTool(
				"manage_entity_schema",
				{
					schema_type: "relationship_type",
					action: "update",
					slug: "symmetric-then-flip",
					is_symmetric: false,
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/is_symmetric.*create|create.*is_symmetric|recreate/i);
		// Unchanged — no silent partial apply.
		expect(await fetchIsSymmetric("symmetric-then-flip")).toBe(true);
	});

	it("rejects `update` with is_symmetric even when a real patch field is also present", async () => {
		await createRelType("asymmetric-then-flip", false);
		// name is valid for update, but is_symmetric must NOT be silently dropped —
		// the whole call must reject so the caller learns is_symmetric is immutable.
		await expect(
			executeTool(
				"manage_entity_schema",
				{
					schema_type: "relationship_type",
					action: "update",
					slug: "asymmetric-then-flip",
					name: "Renamed",
					is_symmetric: true,
				},
				TEST_ENV,
				ownerCtx,
			),
		).rejects.toThrow(/is_symmetric.*create|create.*is_symmetric|recreate/i);
		expect(await fetchIsSymmetric("asymmetric-then-flip")).toBe(false);
	});

	it("still applies a legitimate update field (name) without is_symmetric", async () => {
		// Control: the reject path must not break real updates.
		await createRelType("rename-target", true);
		const res = (await executeTool(
			"manage_entity_schema",
			{
				schema_type: "relationship_type",
				action: "update",
				slug: "rename-target",
				name: "Renamed Via Update",
			},
			TEST_ENV,
			ownerCtx,
		)) as { relationship_type?: { name?: string } };
		expect(res.relationship_type?.name).toBe("Renamed Via Update");
		// is_symmetric unchanged by the name-only update.
		expect(await fetchIsSymmetric("rename-target")).toBe(true);
	});
});
