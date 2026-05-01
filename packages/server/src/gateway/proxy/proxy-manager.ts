import type { Server } from "node:http";
import { createLogger } from "@lobu/core";
import { startHttpProxy, stopHttpProxy } from "./http-proxy.js";

const logger = createLogger("proxy-manager");

let proxyServer: Server | null = null;

/**
 * Start filtering HTTP proxy for worker network isolation. Workers can
 * only reach the internet through this proxy, which enforces domain
 * allowlist/blocklist + LLM egress judge.
 *
 * Behavior based on environment configuration:
 * - Empty/unset: Deny all (complete isolation)
 * - WORKER_ALLOWED_DOMAINS=*: Allow all (unrestricted)
 * - WORKER_ALLOWED_DOMAINS=domains: Allowlist mode
 * - WORKER_DISALLOWED_DOMAINS=domains: Blocklist mode
 * - Both set: Allowlist with exceptions
 */
export async function startFilteringProxy(): Promise<void> {
  if (proxyServer) {
    return;
  }

  const parsedPort = Number.parseInt(
    process.env.WORKER_PROXY_PORT || "8118",
    10
  );
  const port = Number.isFinite(parsedPort) ? parsedPort : 8118;
  // Bind to localhost only — workers run as subprocesses on the same host
  // and connect via 127.0.0.1.
  const host = "127.0.0.1";

  try {
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
export async function stopFilteringProxy(): Promise<void> {
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
