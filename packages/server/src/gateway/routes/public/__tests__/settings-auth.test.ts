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
 *   - verifySettingsSession: injected auth provider wins over cookie
 *   - verifySettingsSession: provider returning null falls back to cookie
 *   - verifySettingsSession: no provider + no cookie → null
 *   - verifySettingsSession: expired cookie with no provider → null
 *   - setSettingsSessionCookie: produces valid encrypted cookie
 *   - setSettingsSessionCookie: cookie is httpOnly and sameSite=Lax
 *   - setSettingsSessionCookie: NOT Secure over plain HTTP
 *   - setSettingsSessionCookie: IS Secure with x-forwarded-proto: https
 *   - setSettingsSessionCookie: maxAge is positive
 *   - isSecureRequest: x-forwarded-proto comma list uses first value
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { encrypt } from "@lobu/core";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import {
  setAuthProvider,
  setSettingsSessionCookie,
  verifySettingsSession,
  verifySettingsToken,
} from "../settings-auth.js";

// ─── Encryption key setup ─────────────────────────────────────────────────────

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ALT_KEY =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  setAuthProvider(null);
});

afterEach(() => {
  setAuthProvider(null);
  delete process.env.ENCRYPTION_KEY;
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeEncryptedToken(payload: object): string {
  return encrypt(JSON.stringify(payload));
}

// ─── verifySettingsToken ──────────────────────────────────────────────────────

describe("verifySettingsToken", () => {
  test("valid token with future exp → returns payload", () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    });
    const result = verifySettingsToken(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe("u1");
    expect(result!.platform).toBe("web");
  });

  test("null input → null", () => {
    expect(verifySettingsToken(null)).toBeNull();
  });

  test("undefined input → null", () => {
    expect(verifySettingsToken(undefined)).toBeNull();
  });

  test("empty string → null", () => {
    expect(verifySettingsToken("")).toBeNull();
  });

  test("whitespace-only string → null", () => {
    expect(verifySettingsToken("   ")).toBeNull();
  });

  test("plaintext (non-encrypted) string → null", () => {
    expect(verifySettingsToken("not-an-encrypted-token")).toBeNull();
  });

  test("expired token (exp in the past) → null", () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() - 1000,
    });
    expect(verifySettingsToken(token)).toBeNull();
  });

  test("token with exp = 0 is rejected (!payload.exp falsy check)", () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: 0,
    });
    expect(verifySettingsToken(token)).toBeNull();
  });

  test("token missing userId → null", () => {
    const token = makeEncryptedToken({
      platform: "web",
      exp: Date.now() + 60_000,
    });
    expect(verifySettingsToken(token)).toBeNull();
  });

  test("token missing exp → null", () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
    });
    expect(verifySettingsToken(token)).toBeNull();
  });

  test("tampered ciphertext → null", () => {
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    });
    const parts = token.split(":");
    const flipped =
      parts[2]!.slice(0, -1) + (parts[2]!.slice(-1) === "a" ? "b" : "a");
    const tampered = `${parts[0]}:${parts[1]}:${flipped}`;
    expect(verifySettingsToken(tampered)).toBeNull();
  });

  test("wrong-key token → null (key rotation / leakage scenario)", () => {
    // Encrypt with ALT_KEY, then switch back to TEST_KEY: AES-GCM tag fails.
    process.env.ENCRYPTION_KEY = ALT_KEY;
    const token = makeEncryptedToken({
      userId: "u1",
      platform: "web",
      exp: Date.now() + 60_000,
    });
    process.env.ENCRYPTION_KEY = TEST_KEY; // switch back
    expect(verifySettingsToken(token)).toBeNull();
  });

  test("valid token preserves optional fields", () => {
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
    const result = verifySettingsToken(token);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-x");
    expect(result!.channelId).toBe("C-001");
    expect(result!.teamId).toBe("T-001");
    expect(result!.settingsMode).toBe("admin");
    expect(result!.isAdmin).toBe(true);
  });

  test("non-JSON plaintext encrypted → null (JSON.parse fails)", () => {
    const token = encrypt("this is not json");
    expect(verifySettingsToken(token)).toBeNull();
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
    app.get("/test", (c) => {
      capturedResult = verifySettingsSession(c);
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
    app.get("/test", (c) => {
      capturedResult = verifySettingsSession(c);
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
    app.get("/test", (c) => {
      capturedResult = verifySettingsSession(c);
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
    app.get("/test", (c) => {
      capturedResult = verifySettingsSession(c);
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
    app.get("/test", (c) => {
      capturedResult = verifySettingsSession(c);
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
    const decoded = verifySettingsToken(cookieVal);
    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe("u1");
    expect(decoded!.platform).toBe("web");
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
