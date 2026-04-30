import { randomBytes } from "node:crypto";
import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import type { ExternalAuthClient } from "../../auth/external/client.js";
import { resolvePublicUrl } from "../../utils/public-url.js";
import {
  setSettingsSessionCookie,
  verifySettingsSession,
  verifySettingsToken,
} from "./settings-auth.js";

const logger = createLogger("connect-auth-routes");
const AUTH_REQUEST_TTL_SECONDS = 10 * 60;
const CONNECT_OAUTH_TTL_SECONDS = 10 * 60;
const SCOPE_CONNECT = "cli:auth:connect";

interface ConnectOauthState {
  returnUrl: string;
  codeVerifier: string;
}

interface ConnectAuthRoutesConfig {
  externalAuthClient?: ExternalAuthClient;
}

function normalizeReturnUrl(
  returnUrl: string | null | undefined
): string | null {
  const value = returnUrl?.trim();
  if (!value?.startsWith("/") || value.startsWith("//")) {
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

async function loadOauthState<T>(
  scope: string,
  id: string
): Promise<T | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT payload FROM oauth_states
    WHERE id = ${id} AND scope = ${scope} AND expires_at > now()
  `;
  return ((rows[0] as { payload: T } | undefined)?.payload ?? null) as T | null;
}

async function saveOauthState<T>(
  scope: string,
  id: string,
  value: T,
  ttlSeconds: number
): Promise<void> {
  const sql = getDb();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await sql`
    INSERT INTO oauth_states (id, scope, payload, expires_at)
    VALUES (${id}, ${scope}, ${sql.json(value as object)}, ${expiresAt})
    ON CONFLICT (id) DO UPDATE SET
      scope = EXCLUDED.scope,
      payload = EXCLUDED.payload,
      expires_at = EXCLUDED.expires_at
  `;
}

async function deleteOauthState(scope: string, id: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM oauth_states WHERE id = ${id} AND scope = ${scope}`;
}

/**
 * Browser-based OAuth handoff used to claim a settings session via a bot
 * link or to sign in to the agent settings UI through the external IdP.
 *
 * - `GET /connect/oauth/login?returnUrl=…`   — kicks off the upstream OAuth.
 * - `GET /connect/claim?claim=…&agent=…`     — exchanges a signed claim token
 *                                              for a settings session cookie.
 * - `GET /connect/oauth/callback`             — completes the handoff.
 */
export function createConnectAuthRoutes(config: ConnectAuthRoutesConfig): Hono {
  const router = new Hono();

  async function loadConnectState(
    state: string
  ): Promise<ConnectOauthState | null> {
    return loadOauthState<ConnectOauthState>(SCOPE_CONNECT, state);
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
      await saveOauthState<ConnectOauthState>(
        SCOPE_CONNECT,
        state,
        { returnUrl, codeVerifier },
        CONNECT_OAUTH_TTL_SECONDS
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

  router.get("/connect/claim", async (c) => {
    const claim = c.req.query("claim")?.trim();
    const agentParam = c.req.query("agent")?.trim();
    if (!claim) {
      return c.html(
        renderPage("Invalid Link", "Missing claim token.", "error"),
        400
      );
    }

    const payload = verifySettingsToken(claim);
    if (!payload) {
      return c.html(
        renderPage(
          "Link Expired",
          "This settings link has expired or is invalid. Ask the bot to send a new one.",
          "error"
        ),
        410
      );
    }

    setSettingsSessionCookie(c, payload);

    const targetAgentId = agentParam || payload.agentId;
    const redirectUrl = targetAgentId
      ? `/api/v1/agents/${encodeURIComponent(targetAgentId)}/config`
      : "/api/v1/agents";
    return c.redirect(redirectUrl);
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
    await deleteOauthState(SCOPE_CONNECT, state);
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
