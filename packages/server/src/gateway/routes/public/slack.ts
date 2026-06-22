import { readFile } from "node:fs/promises";
import { createLogger } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import { createSlackInstallStateStore } from "../../auth/oauth/state-store.js";
import {
  renderOAuthErrorPage,
  renderOAuthSuccessPage,
} from "../../auth/oauth-templates.js";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";

const logger = createLogger("slack-routes");

/**
 * Resolve the active organization id for the current request.
 *
 * Priority:
 *  1. `c.get('organizationId')` — set by the lobuApp wrapper after
 *     `resolveDefaultOrgId(user.id)` (see `lobu/gateway.ts`). This is the
 *     value Postgres-backed stores read via AsyncLocalStorage, so binding
 *     install state to it keeps the OAuth flow aligned with where the
 *     resulting connection row will be written.
 *  2. `c.get('session')?.activeOrganizationId` — better-auth's stamped
 *     active org, used when the wrapper hasn't run (rare; defensive).
 *
 * Returns `null` if neither is present — caller must reject the request
 * (after consulting {@link resolveSingleTenantOrgId} for the self-host
 * fallback).
 */
function readSessionOrgId(c: Context): string | null {
  const fromContext = c.get("organizationId" as never) as
    | string
    | null
    | undefined;
  if (typeof fromContext === "string" && fromContext.length > 0) {
    return fromContext;
  }
  const session = c.get("session" as never) as
    | { activeOrganizationId?: string | null }
    | null
    | undefined;
  const fromSession = session?.activeOrganizationId;
  if (typeof fromSession === "string" && fromSession.length > 0) {
    return fromSession;
  }
  return null;
}

/**
 * Self-host fallback: when there's exactly one organization row in the
 * database, return its id. This keeps `/slack/install` usable on
 * single-tenant deployments where the route is mounted without the
 * lobuApp session middleware that populates `c.get('organizationId')`.
 *
 * Returns `null` when zero or more than one org rows exist — in those
 * cases the caller must reject; we won't silently pick a tenant.
 */
async function resolveSingleTenantOrgId(): Promise<string | null> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT id FROM organization LIMIT 2
    `) as Array<{ id: string }>;
    if (rows.length === 1) return rows[0]!.id;
    return null;
  } catch (err) {
    logger.warn(
      { err: String(err) },
      "Single-tenant org lookup failed — treating as ambiguous"
    );
    return null;
  }
}

/**
 * Resolve the install-flow org for the current request: session-bound first,
 * then the self-host single-tenant fallback. Returns `null` only when
 * neither path yields a definite org — at which point the route must reject.
 */
export async function resolveInstallOrgId(c: Context): Promise<string | null> {
  const sessionOrgId = readSessionOrgId(c);
  if (sessionOrgId) return sessionOrgId;
  return resolveSingleTenantOrgId();
}

const DEFAULT_SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read",
];
type SlackManifest = {
  oauth_config?: {
    scopes?: {
      bot?: string[];
    };
  };
};

function splitScopes(scopes: string): string[] {
  return scopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

async function loadSlackBotScopes(): Promise<string[]> {
  const envScopes =
    process.env.SLACK_OAUTH_SCOPES || process.env.SLACK_BOT_SCOPES;
  if (envScopes) {
    return splitScopes(envScopes);
  }

  const manifestPath =
    process.env.SLACK_MANIFEST_PATH ||
    "config/slack-app-manifest.self-install.json";

  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as SlackManifest;
    const scopes = manifest.oauth_config?.scopes?.bot;
    if (Array.isArray(scopes) && scopes.length > 0) {
      return scopes;
    }
  } catch (error) {
    logger.warn(
      { manifestPath, error: String(error) },
      "Failed to load Slack scopes from manifest, using defaults"
    );
  }

  return DEFAULT_SLACK_BOT_SCOPES;
}

/**
 * Build the Slack OAuth `redirect_uri`. The gateway — and these Slack routes —
 * are served under the public `/lobu` prefix, so the callback lives at
 * `<gateway-base>/slack/oauth_callback` (e.g.
 * `https://app.lobu.ai/lobu/slack/oauth_callback`). `getPublicGatewayUrl()`
 * already encodes that prefix, so append the callback path to it directly.
 *
 * We must NOT route this through `resolvePublicUrl("/slack/oauth_callback")`:
 * an absolute `/slack/...` path resolves against the origin and drops `/lobu`,
 * producing a `redirect_uri` that matches neither the real callback route nor
 * the Slack app's configured redirect-URI allowlist (Slack then rejects the
 * install with "redirect_uri did not match any configured URIs").
 *
 * Falls back to deriving the mount prefix from the request path
 * (`…/slack/install` → `…`) when no public gateway URL is configured.
 */
export function slackOAuthCallbackUrl(
  gatewayBaseUrl: string | undefined,
  requestUrl: string
): string {
  if (gatewayBaseUrl) {
    return `${gatewayBaseUrl.replace(/\/+$/, "")}/slack/oauth_callback`;
  }
  const url = new URL(requestUrl);
  const prefix = url.pathname.replace(/\/slack\/install\/?$/, "");
  return `${url.origin}${prefix}/slack/oauth_callback`;
}

export function createSlackRoutes(manager: ChatInstanceManager): Hono {
  const router = new Hono();

  router.get("/slack/install", async (c) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      return c.html(
        renderOAuthErrorPage(
          "slack_not_configured",
          "Slack OAuth is not configured on this gateway. Set SLACK_CLIENT_ID and try again."
        ),
        503
      );
    }

    // Bind the install to the initiating session's active org. Without this
    // an OAuth link minted under org A's session can be opened from org B's
    // browser and the resulting connection lands in the wrong tenant. On
    // self-host (no session middleware mounted), fall back to the sole org
    // row when exactly one exists — see {@link resolveSingleTenantOrgId}.
    const installOrgId = await resolveInstallOrgId(c);
    if (!installOrgId) {
      return c.html(
        renderOAuthErrorPage(
          "unauthorized",
          "Sign in to an organization before starting Slack install."
        ),
        401
      );
    }

    const stateStore = createSlackInstallStateStore();
    const redirectUri = slackOAuthCallbackUrl(
      manager.getServices().getPublicGatewayUrl?.(),
      c.req.url
    );
    const scopes = await loadSlackBotScopes();
    const state = await stateStore.create({
      redirectUri,
      organizationId: installOrgId,
    });

    const oauthUrl = new URL("https://slack.com/oauth/v2/authorize");
    oauthUrl.searchParams.set("client_id", clientId);
    oauthUrl.searchParams.set("scope", scopes.join(","));
    oauthUrl.searchParams.set("redirect_uri", redirectUri);
    oauthUrl.searchParams.set("state", state);

    return c.redirect(oauthUrl.toString(), 302);
  });

  router.get("/slack/oauth_callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) {
      return c.html(
        renderOAuthErrorPage(
          "invalid_request",
          "The Slack OAuth callback is missing the required state or code parameter."
        ),
        400
      );
    }

    const stateStore = createSlackInstallStateStore();
    // Peek (non-destructive) before validating side-channel context so a
    // cross-org or unauthenticated hit doesn't burn the install link.
    // Consume only after the org check passes — the row stays available
    // for the legitimate caller to retry.
    const oauthState = await stateStore.peek(state);

    if (!oauthState) {
      return c.html(
        renderOAuthErrorPage(
          "invalid_state",
          "This Slack install link is invalid or has expired."
        ),
        400
      );
    }

    // Reject the callback if the session that's completing the install
    // belongs to a different org than the one that started it. Prevents
    // an attacker who phishes the install link from landing a connection
    // in their own org under a victim's authorization. Self-host falls
    // back to the single-tenant resolver (same as `/slack/install`).
    const callbackOrgId = await resolveInstallOrgId(c);
    if (!callbackOrgId || callbackOrgId !== oauthState.organizationId) {
      logger.warn(
        {
          stateOrg: oauthState.organizationId,
          callbackOrg: callbackOrgId ?? null,
        },
        "Rejecting Slack OAuth callback: session org does not match install state"
      );
      return c.html(
        renderOAuthErrorPage(
          "org_mismatch",
          "This Slack install link was started in a different organization. Sign in to that organization and try again."
        ),
        403
      );
    }

    // Org check passed — now atomically consume so the link can't be
    // replayed. If the row is gone between peek and consume (another
    // tab raced), fall through to the same invalid_state response.
    const consumed = await stateStore.consume(state);
    if (!consumed) {
      return c.html(
        renderOAuthErrorPage(
          "invalid_state",
          "This Slack install link is invalid or has expired."
        ),
        400
      );
    }

    try {
      const result = await manager.completeSlackOAuthInstall(
        c.req.raw,
        consumed.redirectUri,
        oauthState.organizationId
      );
      return c.html(
        renderOAuthSuccessPage(result.teamName || result.teamId, undefined, {
          title: "Slack installed",
          description:
            "Workspace connected to Lobu. In a channel, run /lobu link <code> to wire an agent:",
          details: "Get a code from an agent's Deploy tab in your Lobu dashboard.",
        })
      );
    } catch (error) {
      logger.error({ error: String(error) }, "Slack OAuth callback failed");
      return c.html(
        renderOAuthErrorPage(
          "slack_install_failed",
          error instanceof Error
            ? error.message
            : "Slack OAuth callback failed."
        ),
        500
      );
    }
  });

  router.post("/slack/events", async (c) => {
    // Reject webhooks whose timestamp is outside Slack's 5-minute window.
    //
    // HMAC signature verification proper happens downstream in the Chat SDK
    // Slack adapter — `@chat-adapter/slack`'s `SlackAdapter.handleWebhook()`
    // recomputes `v0={HMAC-SHA256(signingSecret, "v0:{ts}:{rawBody}")}` and
    // `timingSafeEqual`s it against `x-slack-signature`, returning a 401 on
    // mismatch (see `verifySignature`). Every path out of this route reaches
    // that adapter: `manager.handleSlackAppWebhook` → `SlackConnection
    // Coordinator.handleAppWebhook` → `forwardWebhook` → `ChatInstanceManager
    // .handleWebhook` → `chat.webhooks.slack` (the adapter), or the OAuth
    // fallback chat that calls `adapter.handleWebhook` directly.
    //
    // Enforcing the freshness window here as well is cheap defense-in-depth:
    // it rejects replays of an intercepted (still-signed) payload before any
    // body parsing, independent of the adapter.
    const tsHeader = c.req.header("x-slack-request-timestamp");
    if (tsHeader) {
      const ts = Number(tsHeader);
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 60 * 5) {
        logger.warn(
          { tsHeader, nowSec },
          "Rejecting Slack webhook: timestamp outside 5-minute window"
        );
        return c.text("stale request", 400);
      }
    }

    try {
      return await manager.handleSlackAppWebhook(c.req.raw);
    } catch (error) {
      logger.error({ error: String(error) }, "Slack event handling failed");
      return c.text("Slack webhook processing failed", 500);
    }
  });

  return router;
}
