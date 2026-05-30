/**
 * Integration tests for the username side effect of
 * `ensurePersonalOrganization`. The frontend resolves a user's home org from
 * `session.user.username` (personalOrgSlug); mirroring the personal org slug
 * onto username lets the home route resolve synchronously instead of waiting
 * on `/api/organizations`. Must be set-when-null, idempotent, and never
 * collide with another user's username.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { generateSecureToken } from "../../../auth/oauth/utils";
import { ensurePersonalOrganization } from "../../../auth/personal-org-provisioning";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

async function seedUser(opts: {
	name: string;
	username?: string | null;
}): Promise<{ id: string; email: string }> {
	const id = `user_${generateSecureToken(6)}`;
	const email = `${id}@test.local`;
	const sql = getTestDb();
	await sql`
    INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
    VALUES (${id}, ${opts.name}, ${email}, ${opts.username ?? null}, true, NOW(), NOW())
  `;
	return { id, email };
}

async function readUsername(userId: string): Promise<string | null> {
	const sql = getTestDb();
	const rows =
		await sql`SELECT username FROM "user" WHERE id = ${userId} LIMIT 1`;
	return (rows[0]?.username as string | null) ?? null;
}

describe("ensurePersonalOrganization username backfill", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("sets username to the personal org slug when unset, and creates an owner membership", async () => {
		const { id, email } = await seedUser({
			name: "Backfill Me",
			username: null,
		});

		const res = await ensurePersonalOrganization({
			id,
			email,
			name: "Backfill Me",
			username: null,
		});
		expect(res.created).toBe(true);
		expect(res.slug).toBe("backfill-me");

		expect(await readUsername(id)).toBe(res.slug);

		const sql = getTestDb();
		const members = await sql`
      SELECT role FROM "member" WHERE "userId" = ${id} AND "organizationId" = ${res.organizationId}
    `;
		expect(members).toHaveLength(1);
		expect(String(members[0].role)).toBe("owner");
	});

	it("does not overwrite an existing username (idempotent)", async () => {
		const { id, email } = await seedUser({
			name: "Has Handle",
			username: "custom-handle",
		});

		await ensurePersonalOrganization({
			id,
			email,
			name: "Has Handle",
			username: "custom-handle",
		});

		expect(await readUsername(id)).toBe("custom-handle");
	});

	it("leaves username null when the slug is already taken by another user", async () => {
		// User A squats the username 'clash' (no org).
		await seedUser({ name: "A", username: "clash" });
		// User B's personal org slug derives to 'clash'.
		const { id, email } = await seedUser({ name: "Clash", username: null });

		const res = await ensurePersonalOrganization({
			id,
			email,
			name: "Clash",
			username: null,
		});
		expect(res.slug).toBe("clash");

		// The NOT EXISTS guard prevents stealing A's username; B stays null.
		expect(await readUsername(id)).toBeNull();
	});
});
