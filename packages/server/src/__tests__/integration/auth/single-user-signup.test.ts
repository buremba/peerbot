/**
 * Integration test for the single-user-mode sign-up guard in
 * `auth/index.tsx` (`databaseHooks.user.create.before`).
 *
 * Pins two contracts:
 *
 *  1. The guard counts real humans correctly — the synthetic
 *     install_operator row is excluded, so the FIRST human signup
 *     proceeds and the SECOND is refused with
 *     SIGN_UP_DISABLED_IN_SINGLE_USER_MODE.
 *
 *  2. The guard does not deadlock. Sign-up runs inside Better Auth's
 *     runWithTransaction, which reserves a pooled connection. The hook must
 *     reuse that transaction connection via ctx.internalAdapter rather than
 *     asking getDb() for a second one — issue #947, where a regression to a
 *     fresh getDb() query hung the request and failed on timeout.
 *
 * The test is backend-agnostic — it talks to the auth handler over a
 * Request and reads DATABASE_URL like the rest of the suite, so it runs
 * unchanged against any Postgres backend.
 */

import { verifyPassword } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAuthCacheForTests, createAuth } from "../../../auth/index";
import { getEnvFromProcess } from "../../../utils/env";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";

const SIGN_UP_URL = "http://localhost/api/auth/sign-up/email";

interface SignUpResult {
	status: number;
	body: Record<string, unknown>;
}

async function signUp(input: {
	email: string;
	password: string;
	name: string;
}): Promise<SignUpResult> {
	const auth = await createAuth(getEnvFromProcess());
	const res = await auth.handler(
		new Request(SIGN_UP_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		}),
	);
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, body };
}

async function seedUser(id: string, principalKind: string): Promise<void> {
	const sql = getTestDb();
	await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", principal_kind, "createdAt", "updatedAt")
    VALUES (
      ${id},
      ${id},
      ${`${id}@seed.test`},
      true,
      ${principalKind},
      NOW(),
      NOW()
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

describe("single-user-mode sign-up guard", () => {
	const originalSingleUser = process.env.LOBU_SINGLE_USER;
	const originalSecret = process.env.BETTER_AUTH_SECRET;

	beforeEach(async () => {
		await cleanupTestDatabase();
		process.env.LOBU_SINGLE_USER = "1";
		// Deterministic secret so credential hashing + session signing work.
		process.env.BETTER_AUTH_SECRET = "a".repeat(64);
		// createAuth() memoizes per-org instances (TtlCache). Other test files
		// build the "__system__" instance with LOBU_SINGLE_USER unset; without
		// busting the cache we'd reuse that instance and the guard closure would
		// read the wrong flag.
		clearAuthCacheForTests();
	});

	afterEach(() => {
		if (originalSingleUser === undefined) delete process.env.LOBU_SINGLE_USER;
		else process.env.LOBU_SINGLE_USER = originalSingleUser;
		if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
		else process.env.BETTER_AUTH_SECRET = originalSecret;
		// Don't leak our LOBU_SINGLE_USER=1 instance into the shared cache —
		// a later file's createAuth() would otherwise reuse it.
		clearAuthCacheForTests();
	});

	it("admits the first human signup and makes a sign-in-ready row", async () => {
		// Completes (no #947 deadlock) and returns 200.
		const first = await signUp({
			email: "first@local.test",
			password: "firstpassword99",
			name: "First",
		});
		expect(first.status).toBe(200);
		const userId = (first.body.user as { id?: string } | undefined)?.id;
		expect(userId).toBeTruthy();
		if (!userId) throw new Error("signup returned no user id");

		const sql = getTestDb();
		// input:false means the column was never sent on INSERT — the DB
		// default 'human' must have filled it in (not NULL).
		const rows = (await sql`
      SELECT principal_kind FROM "user" WHERE id = ${userId}
    `) as unknown as Array<{ principal_kind: string }>;
		expect(rows[0]?.principal_kind).toBe("human");

		// The credential row must verify against the submitted password —
		// proves the create transaction committed, not just returned 200.
		const accounts = (await sql`
      SELECT "providerId", password FROM "account" WHERE "userId" = ${userId}
    `) as unknown as Array<{ providerId: string; password: string | null }>;
		expect(accounts[0]?.providerId).toBe("credential");
		const hash = accounts[0]?.password;
		expect(hash).toBeTruthy();
		if (!hash) throw new Error("credential account has no password hash");
		expect(await verifyPassword({ hash, password: "firstpassword99" })).toBe(
			true,
		);
	});

	it("refuses signup once a human already exists", async () => {
		// Seed a committed human directly (not via a prior signup) so the
		// precondition has a clean happens-before and doesn't depend on
		// cross-request visibility timing under the shared test pool.
		await seedUser("existing-human", "human");

		const res = await signUp({
			email: "second@local.test",
			password: "secondpassword99",
			name: "Second",
		});
		expect(res.status).toBe(403);
		expect(res.body.code).toBe("SIGN_UP_DISABLED_IN_SINGLE_USER_MODE");
	});

	it("does not count install_operator as the existing human", async () => {
		await seedUser("user_install_seed", "install_operator");

		// The seeded row is not a real human, so the first human signup
		// must still be admitted.
		const first = await signUp({
			email: "first@local.test",
			password: "firstpassword99",
			name: "First",
		});
		expect(first.status).toBe(200);
	});
});
