import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/client.js";
import {
  createGithubInstallStateStore,
  createOAuthStateStore,
  OAuthStateStore,
  sweepExpiredOAuthStates,
} from "../auth/oauth/state-store.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

describe("OAuthStateStore (Postgres-backed)", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("create + consume round-trips data and is one-time-use", async () => {
    const store = createOAuthStateStore("claude");
    const state = await store.create({
      userId: "u-1",
      agentId: "a-1",
      codeVerifier: "verifier",
    });
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);

    const data = await store.consume(state);
    expect(data).not.toBeNull();
    expect(data?.userId).toBe("u-1");
    expect(data?.agentId).toBe("a-1");
    expect(data?.codeVerifier).toBe("verifier");

    // Replay returns null.
    expect(await store.consume(state)).toBeNull();
  });

  test("consume returns null for unknown / expired state", async () => {
    const store = createOAuthStateStore("claude");
    expect(await store.consume("does-not-exist")).toBeNull();

    // Force-expire an entry and confirm consume rejects it.
    const live = await store.create({
      userId: "u-2",
      agentId: "a-2",
      codeVerifier: "v",
    });
    const sql = getDb();
    await sql`UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE id = ${live}`;
    expect(await store.consume(live)).toBeNull();
  });

  test("scope isolates different state stores even when ids collide", async () => {
    const a = new OAuthStateStore<{ kind: string }>("scope-a", "a");
    const b = new OAuthStateStore<{ kind: string }>("scope-b", "b");

    const sql = getDb();
    const sharedId = "shared-id";
    const expiresAt = new Date(Date.now() + 60_000);
    await sql`
      INSERT INTO oauth_states (id, scope, payload, expires_at)
      VALUES (${sharedId}, 'scope-a', ${sql.json({ kind: "a" })}, ${expiresAt})
    `;

    expect(await b.consume(sharedId)).toBeNull();
    const fromA = await a.consume(sharedId);
    expect(fromA?.kind).toBe("a");
  });

  test("TTL is configurable per-instance (default 5m, override applies)", async () => {
    const sql = getDb();

    // Default store: ~5 minutes out.
    const def = new OAuthStateStore<{ kind: string }>("ttl-default", "ttl-def");
    const before = Date.now();
    const defState = await def.create({ kind: "d" });
    const defRow = (await sql`
      SELECT expires_at FROM oauth_states WHERE id = ${defState}
    `) as unknown as Array<{ expires_at: Date }>;
    const defTtlSec = (defRow[0].expires_at.getTime() - before) / 1000;
    // 5 minutes ± a generous slack for test scheduling.
    expect(defTtlSec).toBeGreaterThan(4 * 60);
    expect(defTtlSec).toBeLessThan(6 * 60);

    // Overridden store: ~30 minutes out.
    const long = new OAuthStateStore<{ kind: string }>("ttl-long", "ttl-long", {
      ttlSeconds: 30 * 60,
    });
    const beforeLong = Date.now();
    const longState = await long.create({ kind: "l" });
    const longRow = (await sql`
      SELECT expires_at FROM oauth_states WHERE id = ${longState}
    `) as unknown as Array<{ expires_at: Date }>;
    const longTtlSec = (longRow[0].expires_at.getTime() - beforeLong) / 1000;
    expect(longTtlSec).toBeGreaterThan(29 * 60);
    expect(longTtlSec).toBeLessThan(31 * 60);
  });

  test("github install-state store uses the ~30-minute TTL", async () => {
    const sql = getDb();
    const store = createGithubInstallStateStore();
    const before = Date.now();
    const state = await store.create({ organizationId: "org-ttl" });
    const row = (await sql`
      SELECT scope, expires_at FROM oauth_states WHERE id = ${state}
    `) as unknown as Array<{ scope: string; expires_at: Date }>;
    expect(row[0].scope).toBe("github:app_install:state");
    const ttlSec = (row[0].expires_at.getTime() - before) / 1000;
    // Comfortably beyond the default 5m that a live install exceeded at 5m24s.
    expect(ttlSec).toBeGreaterThan(29 * 60);
    expect(ttlSec).toBeLessThan(31 * 60);
  });

  test("sweepExpiredOAuthStates deletes only expired rows", async () => {
    const store = createOAuthStateStore("claude");
    const live = await store.create({
      userId: "u-live",
      agentId: "a",
      codeVerifier: "v",
    });
    const dead = await store.create({
      userId: "u-dead",
      agentId: "a",
      codeVerifier: "v",
    });

    const sql = getDb();
    await sql`UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE id = ${dead}`;

    const swept = await sweepExpiredOAuthStates();
    expect(swept).toBe(1);

    // Live one still consumable.
    expect(await store.consume(live)).not.toBeNull();
  });
});
