import type { Context, Next } from "hono";
import { getDb } from "../db/client.js";
import { verifySettingsToken } from "../gateway/routes/public/settings-auth.js";
import { mcpAuth } from "../auth/middleware.js";
import { getCachedOrgBySlug } from "../workspace/multi-tenant.js";

/**
 * Auth for the SSE invalidation stream (`GET /api/:orgSlug/events`).
 *
 * The embedded panel opens this with EventSource, which can't send an
 * Authorization header and has no usable session cookie in the cross-site
 * iframe — so it appends a short-lived `?token=` ticket (from /api/sse-ticket),
 * the same one the agent stream uses. This middleware resolves that ticket to a
 * user, verifies org membership for the requested slug, and sets
 * `organizationId` so the handler can scope the stream. Anything else —
 * first-party cookie / Bearer session token / no ticket — falls through to the
 * normal `mcpAuth` path unchanged. GET-only (EventSource is always GET).
 */
export async function invalidationSseAuth(c: Context, next: Next) {
  // Keep the ?token= ticket out of the next page's Referer.
  c.header("Referrer-Policy", "no-referrer");
  const ticket = c.req.method === "GET" ? c.req.query("token") : undefined;
  if (ticket) {
    const session = await verifySettingsToken(ticket);
    const orgSlug = c.req.param("orgSlug");
    if (session?.userId && orgSlug) {
      const org = await getCachedOrgBySlug(orgSlug);
      if (org) {
        const rows = await getDb()`
          SELECT role FROM "member"
          WHERE "organizationId" = ${org.id} AND "userId" = ${session.userId}
          LIMIT 1
        `;
        if (rows.length > 0) {
          c.set("organizationId", org.id);
          c.set("memberRole", rows[0].role as string);
          return next();
        }
      }
    }
  }
  return mcpAuth(c, next);
}
