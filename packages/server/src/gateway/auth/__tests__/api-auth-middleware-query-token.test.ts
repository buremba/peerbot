/**
 * `allowSettingsQueryToken` on createApiAuthMiddleware — the embedded panel's
 * agent SSE stream uses EventSource (no Authorization header) and authenticates
 * with an encrypted `?token=` ticket. The gate must accept that ticket, but
 * ONLY for GET, so a leaked URL ticket can't drive headerless mutations.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encrypt } from "@lobu/core";
import { Hono } from "hono";
import { createApiAuthMiddleware } from "../api-auth-middleware.js";
import { setAuthProvider } from "../../routes/public/settings-auth.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_KEY;
  setAuthProvider(null); // no injected provider + no cookie → force the ticket path
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
  setAuthProvider(null);
});

function app() {
  const a = new Hono();
  a.use(
    "*",
    createApiAuthMiddleware({
      allowSettingsSession: true,
      allowSettingsQueryToken: true,
      allowWorkerToken: false,
    }),
  );
  const handler = (c: { get: (k: string) => { userId?: string } | undefined; json: (o: unknown) => Response }) =>
    c.json({ userId: c.get("authContext")?.userId ?? null });
  a.get("/r", handler as never);
  a.post("/r", handler as never);
  return a;
}

const ticket = (userId: string, exp = Date.now() + 60_000): string =>
  encrypt(JSON.stringify({ userId, platform: "external", exp }));

const qTicket = (userId: string, exp?: number) =>
  `?token=${encodeURIComponent(ticket(userId, exp))}`;

describe("createApiAuthMiddleware allowSettingsQueryToken", () => {
  test("GET with a valid ?token= ticket authenticates (the EventSource path)", async () => {
    const res = await app().request(`/r${qTicket("user-1")}`, { method: "GET" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { userId: string }).toEqual({ userId: "user-1" });
  });

  test("POST with the same valid ticket is rejected — mutations need a header", async () => {
    const res = await app().request(`/r${qTicket("user-1")}`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("GET with no auth at all → 401", async () => {
    expect((await app().request("/r", { method: "GET" })).status).toBe(401);
  });

  test("GET with a tampered/garbage ticket → 401", async () => {
    const res = await app().request("/r?token=not-a-real-ticket", { method: "GET" });
    expect(res.status).toBe(401);
  });

  test("GET with an expired ticket → 401", async () => {
    const res = await app().request(`/r${qTicket("user-1", Date.now() - 1000)}`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });
});
