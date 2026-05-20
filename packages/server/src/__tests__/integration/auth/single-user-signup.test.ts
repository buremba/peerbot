/**
 * Integration test for the single-user-mode sign-up guard in
 * `auth/index.tsx` (`databaseHooks.user.create.before`).
 *
 * Pins two contracts:
 *
 *  1. The guard counts real humans correctly — the synthetic
 *     install_operator row and the legacy bootstrap-user row are
 *     excluded, so the FIRST human signup proceeds and the SECOND is
 *     refused with SIGN_UP_DISABLED_IN_SINGLE_USER_MODE.
 *
 *  2. The guard does not deadlock. Sign-up runs inside Better Auth's
 *     runWithTransaction, which reserves the only pooled connection in
 *     PGlite mode (LOBU_DISABLE_PREPARE=1 → pool max=1). The hook must
 *     reuse that transaction connection via ctx.internalAdapter rather
 *     than asking getDb() for a second one. Run under
 *     `bun run test:pglite` this test reproduces issue #947: a regression
 *     to a fresh getDb() query hangs the request and fails on timeout.
 *
 * The test is backend-agnostic — it talks to the auth handler over a
 * Request, reads DATABASE_URL like the rest of the suite, and so runs
 * unchanged against external Postgres (default) and PGlite
 * (LOBU_TEST_BACKEND=pglite).
 */

import { verifyPassword } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../../../auth/index";
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
	});

	afterEach(() => {
		if (originalSingleUser === undefined) delete process.env.LOBU_SINGLE_USER;
		else process.env.LOBU_SINGLE_USER = originalSingleUser;
		if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
		else process.env.BETTER_AUTH_SECRET = originalSecret;
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

	it("refuses the second signup once a human exists", async () => {
		const first = await signUp({
			email: "first@local.test",
			password: "firstpassword99",
			name: "First",
		});
		expect(first.status).toBe(200);

		const second = await signUp({
			email: "second@local.test",
			password: "secondpassword99",
			name: "Second",
		});
		expect(second.status).toBe(403);
		expect(second.body.code).toBe("SIGN_UP_DISABLED_IN_SINGLE_USER_MODE");

		const sql = getTestDb();
		const humans = (await sql`
      SELECT count(*)::int AS count FROM "user"
       WHERE principal_kind <> 'install_operator' AND id <> 'bootstrap-user'
    `) as unknown as Array<{ count: number }>;
		expect(humans[0]?.count).toBe(1);
	});

	it("does not count install_operator or bootstrap-user as the existing human", async () => {
		await seedUser("user_install_seed", "install_operator");
		await seedUser("bootstrap-user", "human");

		// Neither seeded row is a real human, so the first human signup
		// must still be admitted.
		const first = await signUp({
			email: "first@local.test",
			password: "firstpassword99",
			name: "First",
		});
		expect(first.status).toBe(200);
	});
});
