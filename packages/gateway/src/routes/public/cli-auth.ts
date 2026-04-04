import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createLogger } from "@lobu/core";
import { type Context, Hono } from "hono";
import { CliTokenService } from "../../auth/cli/token-service";
import type { ExternalAuthClient } from "../../auth/external/client";
import type { IMessageQueue } from "../../infrastructure/queue";
import { resolvePublicUrl } from "../../utils/public-url";
import {
  getClientIp,
  RedisFixedWindowRateLimiter,
} from "../../utils/rate-limiter";
import {
  setSettingsSessionCookie,
  verifySettingsSession,
} from "./settings-auth";

const logger = createLogger("cli-auth-routes");
const AUTH_REQUEST_TTL_SECONDS = 10 * 60;
const POLL_INTERVAL_MS = 2000;
const CONNECT_OAUTH_TTL_SECONDS = 10 * 60;
const ADMIN_LOGIN_RATE_LIMIT = {
  limit: 5,
  windowSeconds: 5 * 60,
};

interface CliAuthResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: {
    userId: string;
    email?: string;
    name?: string;
  };
}

interface CliBrowserAuthState {
  status: "pending" | "complete" | "error";
  createdAt: number;
  error?: string;
  result?: CliAuthResult;
}

interface CliDeviceAuthState {
  status: "pending" | "complete" | "error";
  createdAt: number;
  expiresAt: number;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  error?: string;
  result?: CliAuthResult;
}

interface ConnectOauthState {
  returnUrl: string;
  codeVerifier: string;
}

export interface CliAuthRoutesConfig {
  queue: IMessageQueue;
  externalAuthClient?: ExternalAuthClient;
  allowAdminPasswordLogin?: boolean;
  adminPassword?: string;
}

function normalizeReturnUrl(
  returnUrl: string | null | undefined
): string | null {
  const value = returnUrl?.trim();
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  return value;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(title: string, message: string, tone: "success" | "error") {
  title = escapeHtml(title);
  message = escapeHtml(message);
  const border = tone === "success" ? "#15803d" : "#b91c1c";
  const bg = tone === "success" ? "#f0fdf4" : "#fef2f2";
  const fg = tone === "success" ? "#166534" : "#991b1b";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: #f8fafc;
        color: #0f172a;
        display: grid;
        place-items: center;
        min-height: 100vh;
      }
      .card {
        width: min(34rem, calc(100vw - 2rem));
        background: white;
        border: 1px solid #e2e8f0;
        border-top: 4px solid ${border};
        border-radius: 0.75rem;
        padding: 1.25rem;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
      }
      .status {
        margin-top: 0.75rem;
        padding: 0.875rem 1rem;
        border-radius: 0.5rem;
        background: ${bg};
        color: ${fg};
        line-height: 1.5;
      }
      h1 {
        margin: 0;
        font-size: 1.125rem;
      }
      p {
        margin: 0.5rem 0 0;
        color: #475569;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${title}</h1>
      <p>You can return to the terminal after this page updates.</p>
      <div class="status">${message}</div>
    </main>
  </body>
</html>`;
}

export function createCliAuthRoutes(config: CliAuthRoutesConfig): Hono {
  const router = new Hono();
  const redis = config.queue.getRedisClient();
  const tokenService = new CliTokenService(redis);
  const rateLimiter = new RedisFixedWindowRateLimiter(redis);

  async function loadBrowserRequest(
    requestId: string
  ): Promise<CliBrowserAuthState | null> {
    const raw = await redis.get(getRequestKey(requestId));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as CliBrowserAuthState;
    } catch (error) {
      logger.error("Failed to parse CLI browser auth request", {
        requestId,
        error,
      });
      await redis.del(getRequestKey(requestId));
      return null;
    }
  }

  async function saveBrowserRequest(
    requestId: string,
    value: CliBrowserAuthState
  ): Promise<void> {
    await redis.setex(
      getRequestKey(requestId),
      AUTH_REQUEST_TTL_SECONDS,
      JSON.stringify(value)
    );
  }

  async function loadDeviceRequest(
    deviceAuthId: string
  ): Promise<CliDeviceAuthState | null> {
    const raw = await redis.get(getDeviceRequestKey(deviceAuthId));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as CliDeviceAuthState;
    } catch (error) {
      logger.error("Failed to parse CLI device auth request", {
        deviceAuthId,
        error,
      });
      await redis.del(getDeviceRequestKey(deviceAuthId));
      return null;
    }
  }

  async function saveDeviceRequest(
    deviceAuthId: string,
    value: CliDeviceAuthState
  ): Promise<void> {
    const ttlSeconds = Math.max(
      60,
      Math.ceil((value.expiresAt - Date.now()) / 1000)
    );
    await redis.setex(
      getDeviceRequestKey(deviceAuthId),
      ttlSeconds,
      JSON.stringify(value)
    );
  }

  async function mintCliTokens(user: {
    userId: string;
    email?: string;
    name?: string;
  }): Promise<CliAuthResult> {
    return tokenService.issueTokens(user);
  }

  function verifyPassword(input: string, expected: string): boolean {
    const a = createHash("sha256").update(input).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  }

  async function startBrowserRequest(c: Context) {
    const requestId = randomBytes(24).toString("base64url");
    await saveBrowserRequest(requestId, {
      status: "pending",
      createdAt: Date.now(),
    });

    const loginUrl = resolvePublicUrl(
      `/api/v1/auth/cli/session/login?request=${encodeURIComponent(requestId)}`,
      {
        requestUrl: c.req.url,
      }
    );

    return c.json({
      mode: "browser",
      requestId,
      loginUrl,
      pollIntervalMs: POLL_INTERVAL_MS,
      expiresAt: Date.now() + AUTH_REQUEST_TTL_SECONDS * 1000,
    });
  }

  async function pollBrowserRequest(c: Context, requestId: string) {
    const authRequest = await loadBrowserRequest(requestId);
    if (!authRequest) {
      return c.json(
        {
          status: "error",
          error: "This login request expired. Run `lobu login` again.",
        },
        410
      );
    }

    if (authRequest.status === "pending") {
      return c.json({ status: "pending" });
    }

    if (authRequest.status === "error") {
      await redis.del(getRequestKey(requestId));
      return c.json(
        {
          status: "error",
          error: authRequest.error || "CLI login failed.",
        },
        400
      );
    }

    await redis.del(getRequestKey(requestId));
    return c.json({
      status: "complete",
      ...authRequest.result,
    });
  }

  async function pollDeviceRequest(c: Context, deviceAuthId: string) {
    const externalAuthClient = config.externalAuthClient;
    if (!externalAuthClient) {
      return c.json(
        { error: "CLI login is not configured on this gateway." },
        501
      );
    }

    const authRequest = await loadDeviceRequest(deviceAuthId);
    if (!authRequest) {
      return c.json(
        {
          status: "error",
          error: "This device login request expired. Run `lobu login` again.",
        },
        410
      );
    }

    if (authRequest.status === "complete") {
      await redis.del(getDeviceRequestKey(deviceAuthId));
      return c.json({
        status: "complete",
        ...authRequest.result,
      });
    }

    if (authRequest.status === "error") {
      await redis.del(getDeviceRequestKey(deviceAuthId));
      return c.json(
        {
          status: "error",
          error: authRequest.error || "CLI login failed.",
        },
        400
      );
    }

    try {
      const pollResult = await externalAuthClient.pollDeviceAuthorization(
        deviceAuthId,
        authRequest.interval
      );

      if (pollResult.status === "pending") {
        const nextState: CliDeviceAuthState = {
          ...authRequest,
          interval: Math.max(pollResult.interval ?? authRequest.interval, 1),
        };
        await saveDeviceRequest(deviceAuthId, nextState);
        return c.json({ status: "pending" });
      }

      if (pollResult.status === "error") {
        await redis.del(getDeviceRequestKey(deviceAuthId));
        return c.json(
          {
            status: "error",
            error: pollResult.error,
          },
          400
        );
      }

      const user = pollResult.user;
      if (!user?.sub) {
        await redis.del(getDeviceRequestKey(deviceAuthId));
        return c.json(
          {
            status: "error",
            error:
              "External auth completed, but no user identity was returned.",
          },
          502
        );
      }

      const issued = await mintCliTokens({
        userId: user.sub,
        email: user.email,
        name: user.name,
      });
      await redis.del(getDeviceRequestKey(deviceAuthId));
      return c.json({
        status: "complete",
        ...issued,
      });
    } catch (error) {
      logger.error("Failed to poll CLI device auth flow", {
        deviceAuthId,
        error,
      });
      await redis.del(getDeviceRequestKey(deviceAuthId));
      return c.json(
        {
          status: "error",
          error: "Failed to complete device login.",
        },
        500
      );
    }
  }

  router.post("/cli/start", async (c) => {
    if (!config.externalAuthClient) {
      return c.json(
        { error: "CLI login is not configured on this gateway." },
        501
      );
    }

    try {
      const capabilities = await config.externalAuthClient.getCapabilities();
      if (capabilities.device) {
        const started =
          await config.externalAuthClient.startDeviceAuthorization();
        const expiresAt = Date.now() + started.expiresIn * 1000;
        await saveDeviceRequest(started.deviceAuthId, {
          status: "pending",
          createdAt: Date.now(),
          expiresAt,
          interval: Math.max(started.interval, 1),
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          verificationUriComplete: started.verificationUriComplete,
        });

        return c.json({
          mode: "device",
          deviceAuthId: started.deviceAuthId,
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          verificationUriComplete: started.verificationUriComplete,
          interval: Math.max(started.interval, 1),
          expiresAt,
        });
      }

      if (capabilities.browser) {
        return startBrowserRequest(c);
      }

      return c.json({ error: "CLI login is unavailable." }, 501);
    } catch (error) {
      logger.error("Failed to start CLI auth flow", { error });
      return c.json({ error: "CLI login is unavailable." }, 500);
    }
  });

  router.post("/cli/poll", async (c) => {
    const rawBody = (await c.req.json().catch(() => ({}))) as {
      requestId?: string;
      deviceAuthId?: string;
    };
    const requestId = rawBody.requestId?.trim();
    const deviceAuthId = rawBody.deviceAuthId?.trim();

    if (deviceAuthId) {
      return pollDeviceRequest(c, deviceAuthId);
    }

    if (requestId) {
      return pollBrowserRequest(c, requestId);
    }

    return c.json({ error: "Missing requestId or deviceAuthId" }, 400);
  });

  router.post("/cli/admin-login", async (c) => {
    if (!config.allowAdminPasswordLogin || !config.adminPassword) {
      return c.json(
        { error: "Admin password login is only available in development." },
        403
      );
    }

    const clientIp = getClientIp({
      forwardedFor: c.req.header("x-forwarded-for"),
      realIp: c.req.header("x-real-ip"),
    });
    const rateLimit = await rateLimiter.consume({
      key: `rate-limit:cli:admin-login:${clientIp}`,
      limit: ADMIN_LOGIN_RATE_LIMIT.limit,
      windowSeconds: ADMIN_LOGIN_RATE_LIMIT.windowSeconds,
    });
    if (!rateLimit.allowed) {
      c.header("Retry-After", String(rateLimit.retryAfterSeconds));
      return c.json(
        {
          error: "Too many admin password login attempts. Try again later.",
        },
        429
      );
    }

    const rawBody = (await c.req.json().catch(() => ({}))) as {
      password?: string;
    };
    const password = rawBody.password?.trim();
    if (!password) {
      return c.json({ error: "Missing password" }, 400);
    }

    if (!verifyPassword(password, config.adminPassword)) {
      return c.json({ error: "Invalid admin password." }, 401);
    }

    const issued = await mintCliTokens({
      userId: "admin",
      name: "Admin (dev)",
    });
    await rateLimiter.reset(`rate-limit:cli:admin-login:${clientIp}`);

    logger.info("CLI admin password login completed", {
      userId: "admin",
    });

    return c.json({
      status: "complete",
      ...issued,
    });
  });

  router.get("/cli/session/login", async (c) => {
    if (!config.externalAuthClient) {
      return c.html(
        renderPage(
          "CLI Login Unavailable",
          "This gateway does not have settings OAuth configured.",
          "error"
        ),
        501
      );
    }

    const requestId = c.req.query("request")?.trim();
    if (!requestId) {
      return c.html(
        renderPage("CLI Login Failed", "Missing login request ID.", "error"),
        400
      );
    }

    const authRequest = await loadBrowserRequest(requestId);
    if (!authRequest) {
      return c.html(
        renderPage(
          "CLI Login Expired",
          "This login request has expired. Run `lobu login` again.",
          "error"
        ),
        410
      );
    }

    const returnUrl = `/api/v1/auth/cli/session/complete?request=${encodeURIComponent(requestId)}`;
    return c.redirect(
      `/connect/oauth/login?returnUrl=${encodeURIComponent(returnUrl)}`
    );
  });

  router.get("/cli/session/complete", async (c) => {
    const requestId = c.req.query("request")?.trim();
    if (!requestId) {
      return c.html(
        renderPage("CLI Login Failed", "Missing login request ID.", "error"),
        400
      );
    }

    const authRequest = await loadBrowserRequest(requestId);
    if (!authRequest) {
      return c.html(
        renderPage(
          "CLI Login Expired",
          "This login request has expired. Run `lobu login` again.",
          "error"
        ),
        410
      );
    }

    const session = verifySettingsSession(c);
    const userId = session?.oauthUserId || session?.userId;
    if (!session || !userId) {
      await saveBrowserRequest(requestId, {
        status: "error",
        createdAt: authRequest.createdAt,
        error:
          "OAuth completed, but no authenticated settings session was found.",
      });
      return c.html(
        renderPage(
          "CLI Login Failed",
          "OAuth completed, but the gateway could not establish a login session.",
          "error"
        ),
        401
      );
    }

    try {
      const issued = await mintCliTokens({
        userId,
        email: session.email,
        name: session.name,
      });

      await saveBrowserRequest(requestId, {
        status: "complete",
        createdAt: authRequest.createdAt,
        result: issued,
      });

      logger.info("CLI browser login completed", {
        requestId,
        userId,
        email: session.email,
      });

      return c.html(
        renderPage(
          "CLI Login Complete",
          "Authentication succeeded. You can close this tab and return to the terminal.",
          "success"
        )
      );
    } catch (error) {
      logger.error("Failed to issue CLI tokens", { requestId, error });
      await saveBrowserRequest(requestId, {
        status: "error",
        createdAt: authRequest.createdAt,
        error: "Failed to mint CLI tokens.",
      });
      return c.html(
        renderPage(
          "CLI Login Failed",
          "The gateway could not mint CLI tokens for this login attempt.",
          "error"
        ),
        500
      );
    }
  });

  router.post("/refresh", async (c) => {
    const rawBody = (await c.req.json().catch(() => ({}))) as {
      refreshToken?: string;
    };
    const refreshToken = rawBody.refreshToken?.trim();
    if (!refreshToken) {
      return c.json({ error: "Missing refreshToken" }, 400);
    }

    const refreshed = await tokenService.refreshTokens(refreshToken);
    if (!refreshed) {
      return c.json({ error: "Invalid or expired refresh token." }, 401);
    }

    return c.json(refreshed);
  });

  router.get("/whoami", async (c) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header." }, 401);
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const identity = await tokenService.verifyAccessToken(token);
    if (!identity) {
      return c.json({ error: "Invalid or expired access token." }, 401);
    }

    return c.json({
      user: {
        id: identity.userId,
        email: identity.email,
        name: identity.name,
      },
      email: identity.email,
      name: identity.name,
      userId: identity.userId,
      expiresAt: identity.expiresAt,
    });
  });

  return router;
}

export function createConnectAuthRoutes(config: CliAuthRoutesConfig): Hono {
  const router = new Hono();
  const redis = config.queue.getRedisClient();

  async function loadConnectState(
    state: string
  ): Promise<ConnectOauthState | null> {
    const raw = await redis.get(getConnectStateKey(state));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as ConnectOauthState;
    } catch {
      await redis.del(getConnectStateKey(state));
      return null;
    }
  }

  router.get("/connect/oauth/login", async (c) => {
    if (!config.externalAuthClient) {
      return c.html(
        renderPage(
          "OAuth Unavailable",
          "Browser OAuth login is not configured on this gateway.",
          "error"
        ),
        501
      );
    }

    const returnUrl = normalizeReturnUrl(c.req.query("returnUrl"));
    if (!returnUrl) {
      return c.html(
        renderPage(
          "OAuth Login Failed",
          "Missing or invalid returnUrl.",
          "error"
        ),
        400
      );
    }

    const existingSession = verifySettingsSession(c);
    if (existingSession) {
      return c.redirect(returnUrl);
    }

    try {
      const state = randomBytes(24).toString("base64url");
      const codeVerifier = config.externalAuthClient.generateCodeVerifier();
      await redis.setex(
        getConnectStateKey(state),
        CONNECT_OAUTH_TTL_SECONDS,
        JSON.stringify({ returnUrl, codeVerifier } satisfies ConnectOauthState)
      );

      const redirectUri = resolvePublicUrl("/connect/oauth/callback", {
        requestUrl: c.req.url,
      });
      const authUrl = await config.externalAuthClient.buildAuthUrl(
        state,
        codeVerifier,
        redirectUri
      );

      return c.redirect(authUrl);
    } catch (error) {
      logger.error("Failed to start browser OAuth handoff", { error });
      return c.html(
        renderPage(
          "OAuth Login Failed",
          "The gateway could not start the browser OAuth flow.",
          "error"
        ),
        500
      );
    }
  });

  router.get("/connect/oauth/callback", async (c) => {
    if (!config.externalAuthClient) {
      return c.html(
        renderPage(
          "OAuth Unavailable",
          "Browser OAuth login is not configured on this gateway.",
          "error"
        ),
        501
      );
    }

    const code = c.req.query("code")?.trim();
    const state = c.req.query("state")?.trim();
    if (!code || !state) {
      return c.html(
        renderPage(
          "OAuth Login Failed",
          "Missing OAuth code or state.",
          "error"
        ),
        400
      );
    }

    const connectState = await loadConnectState(state);
    await redis.del(getConnectStateKey(state));
    if (!connectState) {
      return c.html(
        renderPage(
          "OAuth Login Expired",
          "This OAuth login request has expired. Start the flow again.",
          "error"
        ),
        410
      );
    }

    try {
      const redirectUri = resolvePublicUrl("/connect/oauth/callback", {
        requestUrl: c.req.url,
      });
      const credentials = await config.externalAuthClient.exchangeCodeForToken(
        code,
        connectState.codeVerifier,
        redirectUri
      );
      const user = await config.externalAuthClient.fetchUserInfo(
        credentials.accessToken
      );

      setSettingsSessionCookie(c, {
        userId: user.sub,
        platform: "external",
        oauthUserId: user.sub,
        email: user.email,
        name: user.name,
        exp: Date.now() + AUTH_REQUEST_TTL_SECONDS * 1000,
      });

      return c.redirect(connectState.returnUrl);
    } catch (error) {
      logger.error("Failed to complete browser OAuth handoff", { error });
      return c.html(
        renderPage(
          "OAuth Login Failed",
          "The gateway could not complete the browser OAuth flow.",
          "error"
        ),
        500
      );
    }
  });

  return router;
}

function getRequestKey(requestId: string): string {
  return `cli:auth:request:${requestId}`;
}

function getDeviceRequestKey(deviceAuthId: string): string {
  return `cli:auth:device:${deviceAuthId}`;
}

function getConnectStateKey(state: string): string {
  return `cli:auth:connect:${state}`;
}
