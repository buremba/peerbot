import { createLogger } from "@lobu/core";
import type { Context } from "hono";
import { getDb } from "../../../db/client.js";

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

// The Slack event-webhook route (`POST /slack/events`) has been folded into the
// generic app-webhook endpoint `POST /api/v1/app-webhooks/slack` — see the
// declared Slack provider in `app-webhooks.ts`. The OAuth install routes
// (`/slack/install`, `/slack/oauth_callback`) are now mounted by the generic
// `createInstallRoutes` engine (`app-install.ts`) from the connector's
// `installShape: 'oauth-code-exchange'` declaration — no Slack-specific router.
// This module now only exports the shared `resolveInstallOrgId` helper.
