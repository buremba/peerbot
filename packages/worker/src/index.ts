#!/usr/bin/env bun

import {
  createLogger,
  initSentry,
  initTracing,
  moduleRegistry,
} from "@lobu/core";

const logger = createLogger("worker");

import { GatewayClient } from "./gateway/sse-client";
import { startWorkerHttpServer, stopWorkerHttpServer } from "./server";

/**
 * Main entry point for gateway-based persistent worker
 */
async function main() {
  // Register global rejection/exception handlers early
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection:", reason);
    process.exit(1);
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
    process.exit(1);
  });

  logger.info("Starting worker...");

  // Initialize Sentry for error tracking
  await initSentry();

  // Initialize OpenTelemetry tracing for distributed tracing
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlpEndpoint) {
    initTracing({
      serviceName: "lobu-worker",
      otlpEndpoint,
    });
    logger.info(`Tracing initialized: lobu-worker -> ${otlpEndpoint}`);
  }

  // Discover and register available modules
  await moduleRegistry.registerAvailableModules();

  // Initialize all registered modules
  await moduleRegistry.initAll();
  logger.info("✅ Modules initialized");

  logger.info("🔄 Starting in gateway mode (SSE/HTTP-based persistent worker)");

  // Get user ID from environment
  const userId = process.env.USER_ID;

  if (!userId) {
    logger.error(
      "❌ USER_ID environment variable is required for gateway mode"
    );
    process.exit(1);
  }

  try {
    // Get required environment variables
    const deploymentName = process.env.DEPLOYMENT_NAME;
    const dispatcherUrl = process.env.DISPATCHER_URL;
    const workerToken = process.env.WORKER_TOKEN;

    if (!deploymentName) {
      logger.error("❌ DEPLOYMENT_NAME environment variable is required");
      process.exit(1);
    }
    if (!dispatcherUrl) {
      logger.error("❌ DISPATCHER_URL environment variable is required");
      process.exit(1);
    }
    if (!workerToken) {
      logger.error("❌ WORKER_TOKEN environment variable is required");
      process.exit(1);
    }

    // Start HTTP server before connecting to gateway
    const httpPort = await startWorkerHttpServer();
    logger.info(`Worker HTTP server started on port ${httpPort}`);

    // Initialize gateway client directly
    logger.info(`🚀 Starting Gateway-based Persistent Worker`);
    logger.info(`- User ID: ${userId}`);
    logger.info(`- Deployment: ${deploymentName}`);
    logger.info(`- Dispatcher URL: ${dispatcherUrl}`);

    const gatewayClient = new GatewayClient(
      dispatcherUrl,
      workerToken,
      userId,
      deploymentName,
      httpPort
    );

    // Register signal handlers before async operations
    let isShuttingDown = false;

    process.on("SIGTERM", async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info("Received SIGTERM, shutting down gateway worker...");
      await gatewayClient.stop();
      await stopWorkerHttpServer();
      process.exit(0);
    });

    process.on("SIGINT", async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info("Received SIGINT, shutting down gateway worker...");
      await gatewayClient.stop();
      await stopWorkerHttpServer();
      process.exit(0);
    });

    logger.info("🔌 Connecting to dispatcher...");
    await gatewayClient.start();
    logger.info("✅ Gateway worker started successfully");

    // Keep process alive
    await new Promise(() => {
      // Keep process running indefinitely so we can listen messages from the queue
    }); // Wait forever
  } catch (error) {
    logger.error("❌ Gateway worker failed:", error);
    process.exit(1);
  }
}

export type { WorkerConfig } from "./core/types";

main().catch((error) => {
  logger.error("Fatal error in main:", error);
  process.exit(1);
});
