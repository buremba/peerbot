import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { decrypt } from "@lobu/core";
import { MockRedisClient } from "../../../../core/src/__tests__/fixtures/mock-redis";
import {
  createCliAuthRoutes,
  createConnectAuthRoutes,
} from "../../routes/public/cli-auth";

describe("cli auth routes", () => {
  let originalKey: string | undefined;
  let redis: MockRedisClient;
  let queue: { getRedisClient(): MockRedisClient };

  beforeEach(() => {
    mock.restore();
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    redis = new MockRedisClient();
    queue = {
      getRedisClient: () => redis,
    };
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  test("POST /cli/start returns device mode when the external provider supports device auth", async () => {
    const router = createCliAuthRoutes({
      queue: queue as any,
      externalAuthClient: {
        getCapabilities: mock(async () => ({ browser: true, device: true })),
        startDeviceAuthorization: mock(async () => ({
          deviceAuthId: "device-123",
          userCode: "ABCD-EFGH",
          verificationUri: "https://issuer.example.com/device",
          verificationUriComplete:
            "https://issuer.example.com/device?user_code=ABCD-EFGH",
          interval: 5,
          expiresIn: 600,
        })),
      } as any,
    });

    const res = await router.request("/cli/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("device");
    expect(body.deviceAuthId).toBe("device-123");
    expect(body.userCode).toBe("ABCD-EFGH");
  });

  test("POST /cli/start falls back to browser mode when device auth is unavailable", async () => {
    const router = createCliAuthRoutes({
      queue: queue as any,
      externalAuthClient: {
        getCapabilities: mock(async () => ({ browser: true, device: false })),
      } as any,
    });

    const res = await router.request("https://gateway.example.com/cli/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("browser");
    expect(typeof body.requestId).toBe("string");
    expect(body.loginUrl).toContain("/api/v1/auth/cli/session/login?request=");
  });

  test("GET /connect/oauth/login redirects into external browser auth", async () => {
    const router = createConnectAuthRoutes({
      queue: queue as any,
      externalAuthClient: {
        generateCodeVerifier: () => "code-verifier",
        buildAuthUrl: mock(async (state: string, codeVerifier: string) => {
          expect(state).toBeTruthy();
          expect(codeVerifier).toBe("code-verifier");
          return "https://issuer.example.com/oauth/authorize";
        }),
      } as any,
    });

    const res = await router.request(
      "https://gateway.example.com/connect/oauth/login?returnUrl=%2Fdone"
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://issuer.example.com/oauth/authorize"
    );
  });

  test("GET /connect/oauth/callback sets a settings session and redirects back", async () => {
    await redis.setex(
      "cli:auth:connect:state-123",
      600,
      JSON.stringify({
        returnUrl: "/done",
        codeVerifier: "code-verifier",
      })
    );

    const router = createConnectAuthRoutes({
      queue: queue as any,
      externalAuthClient: {
        exchangeCodeForToken: mock(async () => ({
          accessToken: "provider-access-token",
          refreshToken: "provider-refresh-token",
          tokenType: "Bearer",
          expiresAt: Date.now() + 3600_000,
          scopes: ["profile:read"],
        })),
        fetchUserInfo: mock(async () => ({
          sub: "user-123",
          email: "user@example.com",
          name: "Example User",
        })),
      } as any,
    });

    const res = await router.request(
      "https://gateway.example.com/connect/oauth/callback?code=auth-code&state=state-123"
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/done");
    expect(res.headers.get("set-cookie")).toContain("lobu_settings_session=");

    const setCookie = res.headers.get("set-cookie");
    const token = setCookie?.match(/lobu_settings_session=([^;]+)/)?.[1];
    expect(token).toBeTruthy();

    const payload = JSON.parse(decrypt(decodeURIComponent(token!))) as Record<
      string,
      unknown
    >;
    expect(payload.userId).toBe("user-123");
    expect(payload.platform).toBe("external");
    expect(payload.isAdmin).toBeUndefined();
    expect(payload.settingsMode).toBeUndefined();
  });

  test("POST /cli/poll mints Lobu tokens after device auth completes", async () => {
    await redis.setex(
      "cli:auth:device:device-123",
      600,
      JSON.stringify({
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        interval: 5,
        userCode: "ABCD-EFGH",
        verificationUri: "https://issuer.example.com/device",
      })
    );

    const router = createCliAuthRoutes({
      queue: queue as any,
      externalAuthClient: {
        pollDeviceAuthorization: mock(async () => ({
          status: "complete",
          credentials: {
            accessToken: "provider-access-token",
            refreshToken: "provider-refresh-token",
            tokenType: "Bearer",
            expiresAt: Date.now() + 3600_000,
            scopes: ["profile:read"],
          },
          user: {
            sub: "user-123",
            email: "user@example.com",
            name: "Example User",
          },
        })),
      } as any,
    });

    const res = await router.request("/cli/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceAuthId: "device-123" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("complete");
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(body.user.userId).toBe("user-123");
    expect(body.user.email).toBe("user@example.com");
  });

  test("POST /cli/poll returns a completed browser result from stored request state", async () => {
    await redis.setex(
      "cli:auth:request:req-123",
      600,
      JSON.stringify({
        status: "complete",
        createdAt: Date.now(),
        result: {
          accessToken: "lobu-access-token",
          refreshToken: "lobu-refresh-token",
          expiresAt: Date.now() + 3600_000,
          user: {
            userId: "user-123",
            email: "user@example.com",
            name: "Example User",
          },
        },
      })
    );

    const router = createCliAuthRoutes({
      queue: queue as any,
      externalAuthClient: {} as any,
    });

    const res = await router.request("/cli/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-123" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("complete");
    expect(body.user.userId).toBe("user-123");
  });

  test("POST /cli/admin-login mints tokens when development fallback is enabled", async () => {
    const router = createCliAuthRoutes({
      queue: queue as any,
      allowAdminPasswordLogin: true,
      adminPassword: "dev-secret",
    });

    const res = await router.request("/cli/admin-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.0.0.1",
      },
      body: JSON.stringify({ password: "dev-secret" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("complete");
    expect(typeof body.accessToken).toBe("string");
    expect(body.user.userId).toBe("admin");
  });

  test("POST /cli/admin-login is rejected when disabled or password is wrong", async () => {
    const disabledRouter = createCliAuthRoutes({
      queue: queue as any,
      allowAdminPasswordLogin: false,
      adminPassword: "dev-secret",
    });

    const disabled = await disabledRouter.request("/cli/admin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "dev-secret" }),
    });
    expect(disabled.status).toBe(403);

    const enabledRouter = createCliAuthRoutes({
      queue: queue as any,
      allowAdminPasswordLogin: true,
      adminPassword: "dev-secret",
    });

    const wrong = await enabledRouter.request("/cli/admin-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.0.0.1",
      },
      body: JSON.stringify({ password: "wrong-secret" }),
    });
    expect(wrong.status).toBe(401);
  });

  test("POST /cli/admin-login is rate limited per client IP", async () => {
    const router = createCliAuthRoutes({
      queue: queue as any,
      allowAdminPasswordLogin: true,
      adminPassword: "dev-secret",
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await router.request("/cli/admin-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "10.0.0.9",
        },
        body: JSON.stringify({ password: "wrong-secret" }),
      });
      expect(res.status).toBe(401);
    }

    const limited = await router.request("/cli/admin-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.0.0.9",
      },
      body: JSON.stringify({ password: "wrong-secret" }),
    });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();

    const differentIp = await router.request("/cli/admin-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "10.0.0.10",
      },
      body: JSON.stringify({ password: "dev-secret" }),
    });
    expect(differentIp.status).toBe(200);
  });
});
