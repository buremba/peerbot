import { timingSafeEqual } from "node:crypto";
import { verifyWorkerToken } from "@lobu/core";
import type { Context, Next } from "hono";
import { verifySettingsSession } from "../routes/public/settings-auth";
import type { CliTokenService } from "./cli/token-service";
import type { ExternalAuthClient } from "./external/client";

export const TOKEN_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Creates a Hono middleware that enforces the standard auth check:
 *   1. Settings session cookie  2. CLI JWT  3. External OAuth  4. Admin password  5. Worker token
 */
export function createApiAuthMiddleware(opts: {
  adminPassword?: string;
  cliTokenService?: CliTokenService;
  externalAuthClient?: ExternalAuthClient;
  allowWorkerToken?: boolean;
  allowSettingsSession?: boolean;
}) {
  return async (c: Context, next: Next) => {
    // 1. Try settings session cookie when explicitly allowed.
    if (opts.allowSettingsSession && verifySettingsSession(c)) return next();

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const token = authHeader.substring(7);

    // 2. Try CLI JWT
    if (opts.cliTokenService) {
      const identity = await opts.cliTokenService.verifyAccessToken(token);
      if (identity) return next();
    }

    // 3. Try external OAuth token (validated against MEMORY_URL userinfo)
    if (opts.externalAuthClient) {
      try {
        const userInfo = await opts.externalAuthClient.fetchUserInfo(token);
        if (userInfo?.sub) return next();
      } catch {
        // Token not valid for external auth, continue to next method
      }
    }

    // 4. Try admin password
    if (opts.adminPassword) {
      const a = Buffer.from(token);
      const b = Buffer.from(opts.adminPassword);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return next();
      }
    }

    // 5. Try worker token when explicitly allowed for the route
    if (opts.allowWorkerToken !== false) {
      const workerData = verifyWorkerToken(token);
      if (workerData) {
        const tokenAge = Date.now() - workerData.timestamp;
        if (tokenAge <= TOKEN_EXPIRATION_MS) {
          return next();
        }
      }
    }

    return c.json({ success: false, error: "Unauthorized" }, 401);
  };
}
