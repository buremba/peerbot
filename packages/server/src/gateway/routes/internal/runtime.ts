import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { resolveRuntimeCredentials } from "../../runtime/credentials.js";
import { getGatewayRuntimeProvider } from "../../runtime/index.js";
import { commandEnv, errorStatus, resolveWorkspacePath } from "../../runtime/workspace.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

const logger = createLogger("internal-runtime");

type ExecRequest = {
  command?: unknown;
  cwd?: unknown;
  workspaceDir?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
  // NOTE: no `allowedDomains` here — the egress allowlist is NOT trusted from the
  // request body (the worker is the sandbox-ee). It's read from the signed worker
  // token claim below, same as `runtimeProviderId`.
};

/**
 * Generic worker-bash execution route. One route for every runtime provider:
 * the provider is chosen from the signed worker-token claim (never the request
 * body), credentials are resolved gateway-side from the org vault, and the
 * provider runs the command. Replaces the per-provider `/internal/<x>/exec`
 * routes — adding a provider needs no route change.
 */
export function createRuntimeRoutes(): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  router.post("/internal/runtime/exec", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const provider = getGatewayRuntimeProvider(worker.runtimeProviderId);
      if (!provider) {
        return errorResponse(
          c,
          "No runtime provider configured for this agent",
          404
        );
      }
      if (!worker.agentId) {
        return errorResponse(c, "Token missing agent context", 403);
      }

      const body = (await c.req.json().catch(() => null)) as ExecRequest | null;
      if (!body || typeof body.command !== "string" || !body.command.trim()) {
        return errorResponse(c, "Missing command", 400);
      }

      let credentials = await resolveRuntimeCredentials(
        provider,
        worker.organizationId,
        worker.environmentId
      );
      if (!credentials) {
        // No vault/system credential configured. A provider that can
        // self-authenticate (e.g. Vercel via an ambient VERCEL_OIDC_TOKEN when
        // Lobu runs on Vercel) is allowed to proceed with no explicit creds;
        // otherwise fail closed so a misconfigured environment can't run
        // unauthenticated.
        if (provider.canSelfAuth?.()) {
          credentials = { values: {}, source: "system" };
        } else {
          return errorResponse(
            c,
            "Runtime provider credentials unavailable",
            424
          );
        }
      }

      const workspaceDir = resolveWorkspacePath(
        worker.agentId,
        worker.conversationId,
        body.workspaceDir
      );

      const timeoutMs =
        typeof body.timeoutMs === "number" &&
        Number.isFinite(body.timeoutMs) &&
        body.timeoutMs > 0
          ? Math.floor(body.timeoutMs)
          : undefined;

      const result = await provider.exec({
        organizationId: worker.organizationId,
        agentId: worker.agentId,
        conversationId: worker.conversationId,
        workspaceDir,
        credentials,
        command: body.command,
        cwd: body.cwd,
        env: commandEnv(body.env),
        timeoutMs,
        // Authoritative egress allowlist from the SIGNED token, never the body —
        // a compromised worker cannot widen its own sandbox network policy.
        allowedDomains: worker.allowedDomains,
      });

      return c.json({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        sandbox: result.meta,
      });
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Runtime exec failed"
      );
      return errorResponse(
        c,
        error instanceof Error ? error.message : "Runtime exec failed",
        error instanceof Error ? errorStatus(error) : 500
      );
    }
  });

  return router;
}
