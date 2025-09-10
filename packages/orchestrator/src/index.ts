#!/usr/bin/env bun

import { initSentry } from "@peerbot/shared";

// Initialize Sentry monitoring
initSentry();

import { join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import type { BaseDeploymentManager } from "./base/BaseDeploymentManager";
import { DatabasePool } from "./db-connection-pool";
import { DockerDeploymentManager } from "./docker/DockerDeploymentManager";
import { K8sDeploymentManager } from "./k8s/K8sDeploymentManager";
import { QueueConsumer } from "./task-queue-consumer";
import type { OrchestratorConfig } from "./types";

class PeerbotOrchestrator {
  private config: OrchestratorConfig;
  private dbPool: DatabasePool;
  private deploymentManager: BaseDeploymentManager;
  private queueConsumer: QueueConsumer;
  private isRunning = false;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.dbPool = new DatabasePool(config.database);
    this.deploymentManager = this.createDeploymentManager(config);
    this.queueConsumer = new QueueConsumer(config, this.deploymentManager);
  }

  private createDeploymentManager(
    config: OrchestratorConfig
  ): BaseDeploymentManager {
    // Check for explicit deployment mode
    const deploymentMode = process.env.DEPLOYMENT_MODE;

    if (deploymentMode === "docker") {
      if (!this.isDockerAvailable()) {
        throw new Error("DEPLOYMENT_MODE=docker but Docker is not available");
      }
      return new DockerDeploymentManager(config, this.dbPool);
    }

    if (deploymentMode === "kubernetes" || deploymentMode === "k8s") {
      if (!this.isKubernetesAvailable()) {
        throw new Error(
          "DEPLOYMENT_MODE=kubernetes but Kubernetes is not available"
        );
      }
      return new K8sDeploymentManager(config, this.dbPool);
    }

    // Auto-detect deployment mode based on environment
    if (this.isKubernetesAvailable()) {
      return new K8sDeploymentManager(config, this.dbPool);
    }

    if (this.isDockerAvailable()) {
      return new DockerDeploymentManager(config, this.dbPool);
    }

    throw new Error(
      "Neither Kubernetes nor Docker is available. Please ensure one is installed and accessible."
    );
  }

  private isKubernetesAvailable(): boolean {
    try {
      // Check if running in a Kubernetes cluster
      if (process.env.KUBERNETES_SERVICE_HOST) {
        return true;
      }

      // Check if kubectl config is available
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");

      // Check for kubeconfig in default locations
      const kubeconfigPaths = [
        process.env.KUBECONFIG,
        path.join(os.homedir(), ".kube", "config"),
      ].filter(Boolean);

      return kubeconfigPaths.some((configPath) => {
        try {
          return fs.existsSync(configPath) && fs.statSync(configPath).isFile();
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  private isDockerAvailable(): boolean {
    try {
      // Try to connect to Docker daemon
      const { execSync } = require("node:child_process");
      execSync("docker version", { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run database migrations using dbmate
   */
  private async runDbmateMigrations(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log("📦 Running database migrations...");

      // TODO: Emre: I don't want to worry about migrations until we release the first version.
      const { spawn } = require("node:child_process");
      const dbmateProcess = spawn("dbmate", ["up"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `${this.config.database.connectionString}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      dbmateProcess.stdout?.on("data", (data: any) => {
        stdout += data.toString();
        console.log(`[dbmate up] ${data.toString().trim()}`);
      });

      dbmateProcess.stderr?.on("data", (data: any) => {
        stderr += data.toString();
        console.error(`[dbmate up] ${data.toString().trim()}`);
      });

      dbmateProcess.on("close", (code: any) => {
        if (code === 0) {
          console.log(
            "✅ Database created and migrations applied successfully"
          );
          resolve();
        } else {
          console.error(`❌ Database migrations failed with exit code ${code}`);
          console.error("stdout:", stdout);
          console.error("stderr:", stderr);
          reject(new Error(`dbmate failed with exit code ${code}`));
        }
      });

      dbmateProcess.on("error", (error: any) => {
        console.error("❌ Failed to start dbmate:", error);
        reject(error);
      });
    });
  }

  async start(): Promise<void> {
    try {
      // Run database migrations using dbmate (this will create database and run migrations)
      await this.runDbmateMigrations();

      // Start queue consumer
      await this.queueConsumer.start();

      // Setup health endpoints
      this.setupHealthEndpoints();

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      // Run initial cleanup and set up periodic cleanup
      this.setupIdleCleanup();

      this.isRunning = true;
    } catch (error) {
      console.error("❌ Failed to start orchestrator:", error);
      process.exit(1);
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    try {
      // Clear cleanup interval first to prevent new cleanup operations
      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = undefined;
      }

      // Stop queue consumer
      await this.queueConsumer.stop();
      
      await this.dbPool.close();
    } catch (error) {
      console.error("❌ Error during shutdown:", error);
    }
  }

  private setupHealthEndpoints(): void {
    const http = require("node:http");

    const server = http.createServer(async (req: any, res: any) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      res.setHeader("Content-Type", "application/json");

      if (url.pathname === "/health") {
        // Health check endpoint
        const health = {
          service: "peerbot-orchestrator",
          status: this.isRunning ? "healthy" : "unhealthy",
          timestamp: new Date().toISOString(),
          version: "1.0.0",
        };
        res.statusCode = this.isRunning ? 200 : 503;
        res.end(JSON.stringify(health));
      } else if (url.pathname === "/ready") {
        // Readiness check endpoint
        try {
          await this.dbPool.query("SELECT 1");
          const ready = {
            service: "peerbot-orchestrator",
            status: "ready",
            timestamp: new Date().toISOString(),
          };
          res.statusCode = 200;
          res.end(JSON.stringify(ready));
        } catch (error) {
          const notReady = {
            service: "peerbot-orchestrator",
            status: "not ready",
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          };
          res.statusCode = 503;
          res.end(JSON.stringify(notReady));
        }
      } else if (url.pathname === "/stats") {
        // Queue statistics endpoint
        try {
          const stats = await this.queueConsumer.getQueueStats();
          res.statusCode = 200;
          res.end(JSON.stringify(stats));
        } catch (error) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            })
          );
        }
      } else if (req.method === "POST" && url.pathname.startsWith("/scale/")) {
        // Scale deployment endpoint: POST /scale/{deploymentName}/{replicas}
        const pathParts = url.pathname.split("/");
        if (pathParts.length === 4 && pathParts[1] === "scale") {
          const deploymentName = pathParts[2] || "";
          const replicas = parseInt(pathParts[3] || "0", 10);

          if (Number.isNaN(replicas) || replicas < 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Invalid replica count" }));
            return;
          }

          try {
            // Read request body for metadata
            let body = "";
            req.on("data", (chunk: any) => {
              body += chunk.toString();
            });

            req.on("end", async () => {
              try {
                const metadata = body ? JSON.parse(body) : {};

                // Scale the deployment using deployment manager
                await this.deploymentManager.scaleDeployment(
                  deploymentName,
                  replicas
                );

                const result = {
                  service: "peerbot-orchestrator",
                  action: "scale",
                  deployment: deploymentName,
                  replicas: replicas,
                  timestamp: new Date().toISOString(),
                  requestedBy: metadata.requestedBy || "unknown",
                  reason: metadata.reason || "Manual scaling request",
                };

                res.statusCode = 200;
                res.end(JSON.stringify(result));
              } catch (error) {
                console.error(
                  `Failed to scale deployment ${deploymentName}:`,
                  error
                );
                res.statusCode = 500;
                res.end(
                  JSON.stringify({
                    error:
                      error instanceof Error ? error.message : String(error),
                    deployment: deploymentName,
                    requestedReplicas: replicas,
                  })
                );
              }
            });
          } catch (_error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "Failed to read request body" }));
          }
        } else {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              error:
                "Invalid scale endpoint format. Use POST /scale/{deploymentName}/{replicas}",
            })
          );
        }
      } else {
        // 404 for other paths
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });

    const port = process.env.ORCHESTRATOR_PORT || 8080;
    server.listen(port, () => {
      // Server started
    });
  }

  private setupIdleCleanup(): void {
    // Run initial deployment reconciliation after a short delay
    // This prevents issues with immediate Docker API calls on startup
    setTimeout(() => {
      this.deploymentManager.reconcileDeployments().catch((error) => {
        console.error("❌ Initial deployment reconciliation failed:", error);
      });
    }, 5000); // 5 second delay

    // Set up periodic cleanup every minute for more responsive cleanup
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.deploymentManager.reconcileDeployments();
        
        if (this.queueConsumer && typeof this.queueConsumer.performCleanup === 'function') {
          await this.queueConsumer.performCleanup();
        }
      } catch (error) {
        console.error(
          "Error during consolidated cleanup - will retry on next interval:",
          error instanceof Error ? error.message : String(error)
        );
        // Don't exit process - just log the error and continue
      }
    }, 60 * 1000); // 1 minute in milliseconds
  }

  private setupGracefulShutdown(): void {
    const cleanup = async () => {
      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Handle uncaught errors
    process.on("uncaughtException", (error) => {
      console.error("💥 Uncaught exception:", error);
      cleanup();
    });

    process.on("unhandledRejection", (reason) => {
      console.error("💥 Unhandled rejection:", reason);
      cleanup();
    });
  }

  /**
   * Get orchestrator status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: {
        kubernetes: {
          namespace: this.config.kubernetes.namespace,
        },
        queues: {
          retryLimit: this.config.queues.retryLimit,
          expireInSeconds: this.config.queues.expireInSeconds,
        },
      },
    };
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Load environment variables
    const envPath = join(__dirname, "../../../.env");
    dotenvConfig({ path: envPath });

    // Load configuration from environment
    const config: OrchestratorConfig = {
      database: {
        connectionString: process.env.DATABASE_URL!,
      },
      queues: {
        connectionString: process.env.DATABASE_URL!,
        retryLimit: parseInt(process.env.PGBOSS_RETRY_LIMIT || "3", 10),
        retryDelay: parseInt(process.env.PGBOSS_RETRY_DELAY || "30", 10),
        expireInSeconds: parseInt(
          process.env.PGBOSS_EXPIRE_SECONDS || "300",
          10
        ),
      },
      worker: {
        image: {
          repository: process.env.WORKER_IMAGE_REPOSITORY || "peerbot-worker",
          tag: process.env.WORKER_IMAGE_TAG || "latest",
          pullPolicy: process.env.WORKER_IMAGE_PULL_POLICY || "Always",
        },
        resources: {
          requests: {
            cpu: process.env.WORKER_CPU_REQUEST || "100m",
            memory: process.env.WORKER_MEMORY_REQUEST || "256Mi",
          },
          limits: {
            cpu: process.env.WORKER_CPU_LIMIT || "1000m",
            memory: process.env.WORKER_MEMORY_LIMIT || "2Gi",
          },
        },
        idleCleanupMinutes: parseInt(
          process.env.WORKER_IDLE_CLEANUP_MINUTES || "60",
          10
        ),
        maxDeployments: parseInt(process.env.MAX_WORKER_DEPLOYMENTS || "", 10),
      },
      kubernetes: {
        namespace: process.env.KUBERNETES_NAMESPACE || "peerbot",
      },
    };

    // Validate required configuration
    if (!config.database.connectionString) {
      throw new Error("DATABASE_URL is required");
    }

    // Create and start orchestrator
    const orchestrator = new PeerbotOrchestrator(config);
    await orchestrator.start();

    // Keep the process alive
    process.on("SIGUSR1", () => {
      // const _status = orchestrator.getStatus();
    });
  } catch (error) {
    console.error("💥 Failed to start Peerbot Orchestrator:", error);
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}

export { PeerbotOrchestrator };
export type { OrchestratorConfig } from "./types";
