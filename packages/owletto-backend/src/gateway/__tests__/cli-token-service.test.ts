import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
  CliTokenService,
  sweepExpiredCliSessions,
} from "../auth/cli/token-service.js";
import {
  ensureEncryptionKey,
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

describe("CliTokenService (Postgres-backed)", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
  });

  test("issueTokens persists a session and returns identity", async () => {
    const service = new CliTokenService();
    const issued = await service.issueTokens({
      userId: "u-1",
      email: "u@example.com",
      name: "User One",
    });
    expect(issued.user.userId).toBe("u-1");
    expect(typeof issued.accessToken).toBe("string");
    expect(typeof issued.refreshToken).toBe("string");

    const verified = await service.verifyAccessToken(issued.accessToken);
    expect(verified?.userId).toBe("u-1");
    expect(verified?.email).toBe("u@example.com");
  });

  test("refreshTokens rotates the refresh-token id", async () => {
    const service = new CliTokenService();
    const first = await service.issueTokens({ userId: "u-2" });
    const second = await service.refreshTokens(first.refreshToken);
    expect(second).not.toBeNull();
    expect(second!.user.userId).toBe("u-2");

    // Old refresh token no longer rotates because rotation happened.
    expect(await service.refreshTokens(first.refreshToken)).toBeNull();

    // New refresh token works.
    const third = await service.refreshTokens(second!.refreshToken);
    expect(third).not.toBeNull();
  });

  test("revokeSessionByRefreshToken invalidates the session row", async () => {
    const service = new CliTokenService();
    const issued = await service.issueTokens({ userId: "u-3" });

    await service.revokeSessionByRefreshToken(issued.refreshToken);

    expect(await service.verifyAccessToken(issued.accessToken)).toBeNull();
    expect(await service.refreshTokens(issued.refreshToken)).toBeNull();
  });

  test("expired sessions are filtered on read", async () => {
    const service = new CliTokenService();
    const issued = await service.issueTokens({ userId: "u-4" });
    const sql = getDb();
    await sql`UPDATE cli_sessions SET expires_at = now() - interval '1 second' WHERE user_id = 'u-4'`;
    expect(await service.verifyAccessToken(issued.accessToken)).toBeNull();
  });

  test("sweepExpiredCliSessions deletes only expired rows", async () => {
    const service = new CliTokenService();
    await service.issueTokens({ userId: "u-live" });
    await service.issueTokens({ userId: "u-dead" });
    const sql = getDb();
    await sql`UPDATE cli_sessions SET expires_at = now() - interval '1 second' WHERE user_id = 'u-dead'`;

    const swept = await sweepExpiredCliSessions();
    expect(swept).toBe(1);

    const remaining = await sql`SELECT user_id FROM cli_sessions ORDER BY user_id`;
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.user_id).toBe("u-live");
  });
});
