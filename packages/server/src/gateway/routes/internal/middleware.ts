import { verifyWorkerToken } from "@lobu/core";

/**
 * Shared worker authentication middleware for internal routes.
 * Verifies the Bearer token from the Authorization header and sets
 * the decoded token data on `c.var.worker`.
 */
export const authenticateWorker = async (
  c: any,
  next: () => Promise<void>
): Promise<Response | undefined> => {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization" }, 401);
  }
  const workerToken = authHeader.substring(7);
  const tokenData = verifyWorkerToken(workerToken);
  if (!tokenData) {
    return c.json({ error: "Invalid worker token" }, 401);
  }
  c.set("worker", tokenData);
  await next();
  return undefined;
};
