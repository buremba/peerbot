import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { createLogger } from "@lobu/core";
import { startHttpProxy, stopHttpProxy } from "./http-proxy";

const logger = createLogger("proxy-manager");

let proxyServer: Server | null = null;

/**
 * Determine the bind host for the proxy.
 * DEPLOYMENT_MODE=docker is expected to run inside a container. Fail fast if not,
 * then bind to all interfaces so workers on lobu-internal can connect.
 */
function getProxyBindHost(): string {
  const deploymentMode = process.env.DEPLOYMENT_MODE;

  if (deploymentMode === "docker") {
    const runningInContainer =
      existsSync("/.dockerenv") || existsSync("/run/.containerenv");
    if (!runningInContainer) {
      throw new Error(
        "DEPLOYMENT_MODE=docker requires gateway to run inside a container"
      );
    }
  }

  // Docker Compose / K8s: bind to all interfaces
  return "::";
}

/**
 * Start filtering HTTP proxy for worker network isolation
 * Workers can only access internet via this proxy, which enforces domain allowlist/blocklist
 *
 * Behavior based on environment configuration:
 * - Empty/unset: Deny all (complete isolation)
 * - WORKER_ALLOWED_DOMAINS=*: Allow all (unrestricted)
 * - WORKER_ALLOWED_DOMAINS=domains: Allowlist mode
 * - WORKER_DISALLOWED_DOMAINS=domains: Blocklist mode
 * - Both set: Allowlist with exceptions
 */
export async function startFilteringProxy(): Promise<void> {
  try {
    const parsedPort = Number.parseInt(
      process.env.WORKER_PROXY_PORT || "8118",
      10
    );
    const port = Number.isFinite(parsedPort) ? parsedPort : 8118;
    const host = getProxyBindHost();

    proxyServer = await startHttpProxy(port, host);

    logger.debug(`HTTP proxy started on ${host}:${port}`);
  } catch (error) {
    logger.error("Failed to start HTTP proxy:", error);
    throw error;
  }
}

/**
 * Stop filtering proxy (cleanup on shutdown)
 */
async function stopFilteringProxy(): Promise<void> {
  if (proxyServer) {
    logger.info("Stopping HTTP proxy...");
    await stopHttpProxy(proxyServer);
    proxyServer = null;
  }
}

/**
 * Handle graceful shutdown
 */
process.on("SIGTERM", async () => {
  await stopFilteringProxy();
});

process.on("SIGINT", async () => {
  await stopFilteringProxy();
});
