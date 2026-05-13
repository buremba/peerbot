import { verifyWorkerToken } from "@lobu/core";
import type { Context, Next } from "hono";
import { verifySettingsSession } from "../routes/public/settings-auth.js";
import type { ExternalAuthClient } from "./external/client.js";
import { getRevokedTokenStore } from "./revoked-token-store.js";

export const TOKEN_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Creates a Hono middleware that enforces the standard auth check:
 *   1. Settings session cookie  2. Worker token (local)  3. External OAuth
 *
 * The worker-token check is local + cheap, so it runs before the remote OIDC
 * userinfo fetch — a valid worker token never needs to round-trip to the
 * identity provider.
 */
export function createApiAuthMiddleware(opts: {
  externalAuthClient?: ExternalAuthClient;
  allowWorkerToken?: boolean;
  allowSettingsSession?: boolean;
}) {
  const revokedTokens = getRevokedTokenStore();

  return async (c: Context, next: Next) => {
    // 1. Try settings session cookie when explicitly allowed.
    // verifySettingsSession now enforces jti revocation internally.
    if (opts.allowSettingsSession) {
      const session = await verifySettingsSession(c);
      if (session) {
        return next();
      }
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const token = authHeader.substring(7);

    // 2. Try worker token when explicitly allowed for the route (local check).
    if (opts.allowWorkerToken !== false) {
      const workerData = verifyWorkerToken(token);
      if (workerData) {
        const tokenAge = Date.now() - workerData.timestamp;
        if (tokenAge <= TOKEN_EXPIRATION_MS) {
          if (workerData.jti && (await revokedTokens.isRevoked(workerData.jti))) {
            return c.json({ success: false, error: "Unauthorized" }, 401);
          }
          return next();
        }
      }
    }

    // 3. Try external OAuth token (validated against MEMORY_URL userinfo).
    if (opts.externalAuthClient) {
      try {
        const userInfo = await opts.externalAuthClient.fetchUserInfo(token);
        if (userInfo?.sub) return next();
      } catch {
        // Token not valid for external auth, continue to next method
      }
    }

    return c.json({ success: false, error: "Unauthorized" }, 401);
  };
}
