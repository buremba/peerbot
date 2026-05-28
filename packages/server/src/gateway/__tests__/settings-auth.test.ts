/**
 * settings-auth hardening tests
 *
 * Covers:
 *   - verifySettingsToken: valid token accepted
 *   - verifySettingsToken: expired token rejected
 *   - verifySettingsToken: missing userId rejected
 *   - verifySettingsToken: missing exp rejected
 *   - verifySettingsToken: exp = 0 rejected (falsy guard)
 *   - verifySettingsToken: tampered ciphertext rejected
 *   - verifySettingsToken: null/undefined/empty/whitespace input rejected
 *   - verifySettingsToken: plaintext (non-encrypted) string rejected
 *   - verifySettingsToken: wrong-key token rejected (key rotation scenario)
 *   - verifySettingsToken: optional fields preserved
 *   - verifySettingsToken: revoked jti rejected (kill switch)
 *   - verifySettingsSession: injected auth provider wins over cookie
 *   - verifySettingsSession: provider returning null falls back to cookie
 *   - verifySettingsSession: no provider + no cookie → null
 *   - verifySettingsSession: expired cookie with no provider → null
 *   - verifySettingsSession: revoked cookie jti → null
 *   - setSettingsSessionCookie: produces valid encrypted cookie
 *   - setSettingsSessionCookie: cookie is httpOnly and sameSite=Lax
 *   - setSettingsSessionCookie: NOT Secure over plain HTTP
 *   - setSettingsSessionCookie: IS Secure with x-forwarded-proto: https
 *   - setSettingsSessionCookie: maxAge is positive
 *   - setSettingsSessionCookie: mints a jti for revocation
 *   - isSecureRequest: x-forwarded-proto comma list uses first value
 *
 * NOTE: `verifySettingsToken` / `verifySettingsSession` are async and consult
 * a `RevokedTokenStore`. To keep these pure unit tests off Postgres we inject a
 * fake store via `setRevokedTokenStore`; the real singleton (`getDb()`-backed)
 * is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetEncryptionKeyCacheForTests, encrypt } from "@lobu/core";
import { Hono } from "hono";
import type { RevokedTokenStore } from "../auth/revoked-token-store.js";
import type { SettingsTokenPayload } from "../auth/settings/token-service.js";
import {
  setAuthProvider,
  setRevokedTokenStore,
  setSettingsSessionCookie,
  verifySettingsSession,
  verifySettingsToken,
} from "../routes/public/settings-auth.js";

// ─── Encryption key setup ─────────────────────────────────────────────────────

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ALT_KEY =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

// ─── Fake revoked-token store (no DB) ─────────────────────────────────────────

const revokedJtis = new Set<string>();

const fakeStore = {
  async isRevoked(jti: string): Promise<boolean> {
    return revokedJtis.has(jti);
  },
  isRevokedCached(jti: string): boolean {
    return revokedJtis.has(jti);
  },
  async revoke(jti: string): Promise<void> {
    revokedJtis.add(jti);
  },
  async sweepExpired(): Promise<number> {
    return 0;
  },
} as unknown as RevokedTokenStore;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  // The core encrypt/decrypt key is memoized for the process lifetime; reset
  // it so each test (and the wrong-key rotation test below) gets the key it
  // just set rather than one cached by an earlier test.
  __resetEncryptionKeyCacheForTests();
  setAuthProvider(null);
  setRevokedTokenStore(fakeStore);
  revokedJtis.clear();
});

afterEach(() => {
  setAuthProvider(null);
  setRevokedTokenStore(null);
  revokedJtis.clear();
  delete process.env.ENCRYPTION_KEY;
  __resetEncryptionKeyCacheForTests();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeEncryptedToken(payload: object): string {
  return encrypt(JSON.stringify(payload));
}

// ─── verifySettingsToken ──────────────────────────────────────────────────────

describe("verifySettingsToken", () => {
  test("valid token with future exp → returns payload", async () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    });
    const result = await verifySettingsToken(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("u1");
    expect(result!.platform).toBe("web");
  });

  test("null input → null", async () => {
    expect(await verifySettingsToken(null)).toBeNull();
  });

  test("undefined input → null", async () => {
    expect(await verifySettingsToken(undefined)).toBeNull();
  });

  test("empty string → null", async () => {
    expect(await verifySettingsToken("")).toBeNull();
  });

  test("whitespace-only string → null", async () => {
    expect(await verifySettingsToken("   ")).toBeNull();
  });

  test("plaintext (non-encrypted) string → null", async () => {
    expect(await verifySettingsToken("not-an-encrypted-token")).toBeNull();
  });

  test("expired token (exp in the past) → null", async () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() - 1000,
    });
    expect(await verifySettingsToken(token)).toBeNull();
  });

  test("token with exp = 0 is rejected (!payload.exp falsy check)", async () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: 0,
    });
    expect(await verifySettingsToken(token)).toBeNull();
  });

  test("token missing userId → null", async () => {
    const token = makeEncryptedToken({
      platform: "web",
      exp: Date.now() + 60_000,
    });
    expect(await verifySettingsToken(token)).toBeNull();
  });

  test("token missing exp → null", async () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
    });
    expect(await verifySettingsToken(token)).toBeNull();
  });

  test("tampered ciphertext → null", async () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    });
    const parts = token.split(":");
    const flipped =
      parts[2]!.slice(0, -1) + (parts[2]!.slice(-1) === "a" ? "b" : "a");
    const tampered = `${parts[0]}:${parts[1]}:${flipped}`;
    expect(await verifySettingsToken(tampered)).toBeNull();
  });

  test("wrong-key token → null (key rotation / leakage scenario)", async () => {
    // Encrypt with ALT_KEY, then switch back to TEST_KEY: AES-GCM tag fails.
    // The core key is cached per-process, so reset the cache around each
    // switch to force a fresh derivation from the env var.
    process.env.ENCRYPTION_KEY = ALT_KEY;
    __resetEncryptionKeyCacheForTests();
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    });
    process.env.ENCRYPTION_KEY = TEST_KEY; // switch back
    __resetEncryptionKeyCacheForTests();
    expect(await verifySettingsToken(token)).toBeNull();
  });

  test("valid token preserves optional fields", async () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "slack",
      exp: Date.now() + 60_000,
      agentId: "agent-x",
      channelId: "C-001",
      teamId: "T-001",
      settingsMode: "admin",
      isAdmin: true,
    });
    const result = await verifySettingsToken(token);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-x");
    expect(result!.channelId).toBe("C-001");
    expect(result!.teamId).toBe("T-001");
    expect(result!.settingsMode).toBe("admin");
    expect(result!.isAdmin).toBe(true);
  });

  test("non-JSON plaintext encrypted → null (JSON.parse fails)", async () => {
    const token = encrypt("this is not json");
    expect(await verifySettingsToken(token)).toBeNull();
  });

  test("revoked jti → null (kill switch)", async () => {
    const jti = "revoked-jti-1";
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
      jti,
    });
    // Sanity: accepted before revocation.
    expect(await verifySettingsToken(token)).not.toBeNull();
    revokedJtis.add(jti);
    expect(await verifySettingsToken(token)).toBeNull();
  });
});

// ─── verifySettingsSession (injected provider + cookie) ──────────────────────

describe("verifySettingsSession", () => {
  test("injected auth provider returning a session wins over cookie", async () => {
    const providerPayload: SettingsTokenPayload = {
      userId: "provider-user",
      platform: "web",
      exp: Date.now() + 60_000,
    };
    setAuthProvider(() => providerPayload);

    // Build a Hono context with a different (valid) cookie — provider wins.
    const cookieToken = makeEncryptedToken({
      userId: "cookie-user",
      platform: "web",
      exp: Date.now() + 60_000,
    });

    let capturedResult: SettingsTokenPayload | null =
      undefined as unknown as SettingsTokenPayload | null;
    const app = new Hono();
    app.get("/test", async (c) => {
      capturedResult = await verifySettingsSession(c);
      return c.json({});
    });
    const h = new Headers();
    h.set("Cookie", `lobu_settings_session=${cookieToken}`);
    await app.fetch(new Request("http://localhost/test", { headers: h }));

    expect(capturedResult!.userId).toBe("provider-user");
  });

  test("injected provider returning null falls back to cookie", async () => {
    setAuthProvider(() => null);

    const cookieToken = makeEncryptedToken({
      userId: "cookie-user",
      platform: "web",
      exp: Date.now() + 60_000,
    });

    let capturedResult: SettingsTokenPayload | null =
      undefined as unknown as SettingsTokenPayload | null;
    const app = new Hono();
    app.get("/test", async (c) => {
      capturedResult = await verifySettingsSession(c);
      return c.json({});
    });
    const h = new Headers();
    h.set("Cookie", `lobu_settings_session=${cookieToken}`);
    await app.fetch(new Request("http://localhost/test", { headers: h }));

    expect(capturedResult!.userId).toBe("cookie-user");
  });

  test("no provider and no cookie → null", async () => {
    let capturedResult: SettingsTokenPayload | null =
      undefined as unknown as SettingsTokenPayload | null;
    const app = new Hono();
    app.get("/test", async (c) => {
      capturedResult = await verifySettingsSession(c);
      return c.json({});
    });
    await app.fetch(new Request("http://localhost/test"));
    expect(capturedResult).toBeNull();
  });

  test("expired cookie with no provider → null", async () => {
    const cookieToken = makeEncryptedToken({
      userId: "cookie-user",
      platform: "web",
      exp: Date.now() - 1000,
    });

    let capturedResult: SettingsTokenPayload | null =
      undefined as unknown as SettingsTokenPayload | null;
    const app = new Hono();
    app.get("/test", async (c) => {
      capturedResult = await verifySettingsSession(c);
      return c.json({});
    });
    const h = new Headers();
    h.set("Cookie", `lobu_settings_session=${cookieToken}`);
    await app.fetch(new Request("http://localhost/test", { headers: h }));

    expect(capturedResult).toBeNull();
  });

  test("revoked cookie jti → null (kill switch via cookie path)", async () => {
    const jti = "revoked-cookie-jti";
    const cookieToken = makeEncryptedToken({
      userId: "cookie-user",
      platform: "web",
      exp: Date.now() + 60_000,
      jti,
    });
    revokedJtis.add(jti);

    let capturedResult: SettingsTokenPayload | null =
      undefined as unknown as SettingsTokenPayload | null;
    const app = new Hono();
    app.get("/test", async (c) => {
      capturedResult = await verifySettingsSession(c);
      return c.json({});
    });
    const h = new Headers();
    h.set("Cookie", `lobu_settings_session=${cookieToken}`);
    await app.fetch(new Request("http://localhost/test", { headers: h }));

    expect(capturedResult).toBeNull();
  });

  test("cookie with wrong name is not accepted", async () => {
    const cookieToken = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    });

    let capturedResult: SettingsTokenPayload | null =
      undefined as unknown as SettingsTokenPayload | null;
    const app = new Hono();
    app.get("/test", async (c) => {
      capturedResult = await verifySettingsSession(c);
      return c.json({});
    });
    const h = new Headers();
    h.set("Cookie", `wrong_cookie_name=${cookieToken}`);
    await app.fetch(new Request("http://localhost/test", { headers: h }));

    expect(capturedResult).toBeNull();
  });
});

// ─── setSettingsSessionCookie ─────────────────────────────────────────────────

describe("setSettingsSessionCookie", () => {
  test("produces a valid encrypted cookie that round-trips through verifySettingsToken", async () => {
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const res = await app.fetch(new Request("http://localhost/set"));
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("lobu_settings_session=");

    // Decode and verify
    const match = setCookieHeader.match(/lobu_settings_session=([^;]+)/);
    expect(match).not.toBeNull();
    const cookieVal = decodeURIComponent(match![1]!);
    const decoded = await verifySettingsToken(cookieVal);
    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe("u1");
    expect(decoded!.platform).toBe("web");
  });

  test("mints a jti so the issued cookie can be revoked", async () => {
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const res = await app.fetch(new Request("http://localhost/set"));
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    const match = setCookieHeader.match(/lobu_settings_session=([^;]+)/);
    const cookieVal = decodeURIComponent(match![1]!);
    const decoded = await verifySettingsToken(cookieVal);
    expect(decoded).not.toBeNull();
    expect(typeof (decoded as { jti?: string }).jti).toBe("string");
    expect((decoded as { jti?: string }).jti!.length).toBeGreaterThan(0);
  });

  test("cookie is httpOnly and sameSite=Lax", async () => {
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const res = await app.fetch(new Request("http://localhost/set"));
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader.toLowerCase()).toContain("httponly");
    expect(setCookieHeader.toLowerCase()).toContain("samesite=lax");
  });

  test("cookie is NOT Secure over plain HTTP (no x-forwarded-proto)", async () => {
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const res = await app.fetch(new Request("http://localhost/set"));
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    // Hono omits "Secure" when secure:false
    expect(setCookieHeader.toLowerCase()).not.toContain("; secure");
  });

  test("cookie IS Secure when x-forwarded-proto: https", async () => {
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const h = new Headers();
    h.set("x-forwarded-proto", "https");
    const res = await app.fetch(
      new Request("http://localhost/set", { headers: h })
    );
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader.toLowerCase()).toContain("secure");
  });

  test("x-forwarded-proto comma list uses the first value", async () => {
    // "https, http" → first value is https → Secure flag set.
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const h = new Headers();
    h.set("x-forwarded-proto", "https, http");
    const res = await app.fetch(
      new Request("http://localhost/set", { headers: h })
    );
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader.toLowerCase()).toContain("secure");
  });

  test("x-forwarded-proto: http does NOT set Secure flag", async () => {
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const h = new Headers();
    h.set("x-forwarded-proto", "http");
    const res = await app.fetch(
      new Request("http://localhost/set", { headers: h })
    );
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader.toLowerCase()).not.toContain("; secure");
  });

  test("maxAge is positive even for long-lived sessions", async () => {
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 1 week
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const res = await app.fetch(new Request("http://localhost/set"));
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    const maxAgeMatch = setCookieHeader.match(/max-age=(\d+)/i);
    expect(maxAgeMatch).not.toBeNull();
    const maxAge = parseInt(maxAgeMatch![1]!, 10);
    expect(maxAge).toBeGreaterThan(0);
  });

  test("cookie path is /", async () => {
    const session: SettingsTokenPayload = {
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    };

    const app = new Hono();
    app.get("/set", (c) => {
      setSettingsSessionCookie(c, session);
      return c.json({});
    });

    const res = await app.fetch(new Request("http://localhost/set"));
    const setCookieHeader = res.headers.get("set-cookie") ?? "";
    expect(setCookieHeader.toLowerCase()).toContain("path=/");
  });
});
