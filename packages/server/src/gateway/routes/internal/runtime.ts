import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { resolveRuntimeCredentials } from "../../runtime/credentials.js";
import { getGatewayRuntimeProvider } from "../../runtime/index.js";
import { sanitizeNixPackages } from "../../runtime/packages.js";
import { commandEnv, errorStatus, resolveWorkspacePath } from "../../runtime/workspace.js";
import type { PackageProvisionResult } from "../../runtime/types.js";
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
  //
  // NOTE: no `nixPackages` here either, for exactly the same reason. Every entry
  // becomes an argument to a `nix profile install` command line inside the
  // sandbox; a worker that could name its own package set could install
  // arbitrary nixpkgs attributes — and widen its own toolset past what its org
  // configured. The list is read from the signed claim below and re-validated.
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
        worker.sandboxId
      );
      if (!credentials) {
        // No vault/system credential resolved. Provider self-auth (e.g. Vercel
        // via an ambient VERCEL_OIDC_TOKEN when Lobu itself runs on Vercel) is
        // the HOST realm — permissible ONLY for a sandbox-less resolution
        // (self-host / org default). A sandbox-bound miss must fail closed: a
        // conversation pinned to a specific sandbox that's been deleted or
        // misconfigured must NOT silently execute in the host realm under ambient
        // OIDC — that would break the one-conversation-one-realm pin contract.
        if (!worker.sandboxId && provider.canSelfAuth?.()) {
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

      // Authoritative package set from the SIGNED token, never the body, and
      // re-validated through the shared nix sanitizer before it can reach any
      // command line. Sanitizing here (not only in the provider) keeps the one
      // check on the path EVERY provider inherits.
      const nixPackages = sanitizeNixPackages(worker.nixPackages);

      const execContext = {
        organizationId: worker.organizationId,
        agentId: worker.agentId,
        conversationId: worker.conversationId,
        workspaceDir,
        credentials,
        command: body.command,
        cwd: body.cwd,
        env: commandEnv(body.env),
        timeoutMs,
        // Authoritative egress allow/deny lists from the SIGNED token, never
        // the body — a compromised worker cannot widen its own sandbox policy.
        allowedDomains: worker.allowedDomains,
        deniedDomains: worker.deniedDomains,
        nixPackages,
      };

      // Provision BEFORE the command runs, and only when there is something to
      // provision. The provider applies the sandbox network policy (including
      // the nix substituter hosts) as part of this call — the install would
      // otherwise hang against a deny-by-default sandbox.
      //
      // A provider without `ensurePackages` cannot provision: that is the
      // honest-degradation path. We log it and run the command anyway rather
      // than failing the turn or pretending the tool is present.
      let packages: PackageProvisionResult | undefined;
      if (nixPackages.length > 0) {
        if (provider.ensurePackages) {
          packages = await provider.ensurePackages(execContext);
        } else {
          logger.warn(
            { provider: provider.id, packages: nixPackages },
            "Runtime provider cannot provision packages — the contributed CLIs will be absent"
          );
          packages = {
            installed: [],
            failed: nixPackages,
            cached: false,
            error: `Provider ${provider.id} does not support package provisioning`,
          };
        }
      }

      // Providers decide whether to expose their package profile based on what
      // provisioning actually achieved — see `RuntimeExecContext.provisioned`.
      const result = await provider.exec({ ...execContext, provisioned: packages });

      return c.json({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        sandbox: packages ? { ...result.meta, packages } : result.meta,
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
