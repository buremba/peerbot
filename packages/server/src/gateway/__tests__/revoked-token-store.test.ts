import { generateWorkerToken, verifyWorkerToken } from "@lobu/core";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createApiAuthMiddleware } from "../auth/api-auth-middleware.js";
import {
  getRevokedTokenStore,
  RevokedTokenStore,
} from "../auth/revoked-token-store.js";
import {
  ensureEncryptionKey,
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";

describe("RevokedTokenStore (PG-backed)", () => {
  let store: RevokedTokenStore;

  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    ensureEncryptionKey();
    store = new RevokedTokenStore();
  });

  test("unknown jti is not revoked", async () => {
    expect(await store.isRevoked("never-seen")).toBe(false);
    expect(await store.isRevoked("")).toBe(false);
  });

  test("revoke() marks a jti as revoked", async () => {
    await store.revoke("jti-1", Date.now() + 60_000);
    // Fresh store (no cache) so this hits Postgres.
    const cold = new RevokedTokenStore();
    expect(await cold.isRevoked("jti-1")).toBe(true);
    expect(await cold.isRevoked("jti-2")).toBe(false);
  });

  test("sweepExpired() removes rows whose expiry has passed", async () => {
    await store.revoke("expired", Date.now() - 1_000);
    await store.revoke("live", Date.now() + 60_000);

    const removed = await store.sweepExpired();
    expect(removed).toBe(1);

    const cold = new RevokedTokenStore();
    expect(await cold.isRevoked("expired")).toBe(false);
    expect(await cold.isRevoked("live")).toBe(true);
  });

  test("an already-expired revocation never reports revoked", async () => {
    await store.revoke("stale", Date.now() - 1_000);
    const cold = new RevokedTokenStore();
    expect(await cold.isRevoked("stale")).toBe(false);
  });
});

describe("createApiAuthMiddleware — worker token revocation", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    ensureEncryptionKey();
  });

  function makeApp() {
    const app = new Hono();
    app.use("*", createApiAuthMiddleware({ allowWorkerToken: true }));
    app.get("/ping", (c) => c.json({ ok: true }));
    return app;
  }

  function workerToken() {
    const token = generateWorkerToken("user-1", "conv-1", "deploy-1", {
      channelId: "chan-1",
    });
    return token;
  }

  function jtiOf(token: string): string {
    // Re-derive the jti the same way the gateway does.
    const data = verifyWorkerToken(token);
    if (!data?.jti) throw new Error("worker token missing jti");
    return data.jti;
  }

  test("a normal worker token is accepted", async () => {
    const app = makeApp();
    const res = await app.request("/ping", {
      headers: { Authorization: `Bearer ${workerToken()}` },
    });
    expect(res.status).toBe(200);
  });

  test("a worker token whose jti is revoked is rejected with 401", async () => {
    const token = workerToken();
    // Revoke its jti via the same singleton the middleware uses.
    await getRevokedTokenStore().revoke(jtiOf(token), Date.now() + 60_000);

    const app = makeApp();
    const res = await app.request("/ping", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});
