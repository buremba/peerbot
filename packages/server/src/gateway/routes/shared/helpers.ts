/**
 * Shared route helpers used across public and internal route modules.
 *
 * Keep this tiny and dependency-free — it exists to collapse the repetitive
 * "auth check / error JSON / context lookup" boilerplate that was previously
 * duplicated in every handler.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import { verifySettingsSession } from "../public/settings-auth.js";
import type { WorkerContext } from "../internal/types.js";

/**
 * Return a standard JSON error response with the shape `{ error: message }`.
 * Mirrors the convention used across public and internal routes.
 */
export function errorResponse(
  c: Context,
  message: string,
  status: ContentfulStatusCode
): Response {
  return c.json({ error: message }, status);
}

/**
 * Resolve the settings session payload, or return a 401 error response.
 *
 * Handlers should call this and early-return when the result is a Response:
 *
 *   const session = requireSession(c);
 *   if (session instanceof Response) return session;
 */
export function requireSession(c: Context): SettingsTokenPayload | Response {
  const payload = verifySettingsSession(c);
  if (!payload) {
    return errorResponse(c, "Unauthorized", 401);
  }
  return payload;
}

/**
 * Return the worker context set by `authenticateWorker` middleware.
 *
 * The middleware has already validated the Bearer token and populated
 * `c.var.worker`. This helper throws if somehow called on a route that
 * wasn't wrapped with `authenticateWorker`, surfacing the wiring mistake
 * at the first request rather than producing confusing `undefined` errors
 * deeper in the handler.
 */
export function getVerifiedWorker(
  c: Context<WorkerContext>
): WorkerContext["Variables"]["worker"] {
  const worker = c.get("worker");
  if (!worker) {
    throw new Error(
      "Worker context missing — route must be wrapped with authenticateWorker middleware"
    );
  }
  return worker;
}
