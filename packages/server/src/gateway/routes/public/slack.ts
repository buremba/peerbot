import { createLogger } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
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
 * database, return its id. This keeps install routes usable on
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

/**
 * Build the Slack OAuth `redirect_uri`. The gateway — and the Slack install
 * routes — are served under the public `/lobu` prefix, so the callback lives
 * at `<gateway-base>/slack/oauth_callback`. `getPublicGatewayUrl()` already
 * encodes that prefix, so append the callback path to it directly.
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

/**
 * Slack event-webhook route. The install routes (`/slack/install` and
 * `/slack/oauth_callback`) have been moved to `createSlackInstallRoutes`
 * in `app-install.ts` alongside the GitHub App install routes.
 */
export function createSlackRoutes(manager: ChatInstanceManager): Hono {
  const router = new Hono();

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
